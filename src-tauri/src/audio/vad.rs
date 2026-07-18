//! Energy-based VAD for hands-free mode.
//!
//! Adaptive noise floor + hysteresis: speech starts after START_MS of voiced
//! audio (with a ~PREBUFFER_MS pre-roll so onsets aren't clipped) and ends
//! after END_SILENCE_MS of silence. While TTS is audibly playing the start
//! threshold is raised to resist triggering on our own speaker output.

use crate::audio::state::TARGET_SAMPLE_RATE;
use std::collections::VecDeque;

const VAD_START_MS: f32 = 60.0;
const VAD_END_SILENCE_MS: f32 = 900.0;
const VAD_PREBUFFER_MS: f32 = 300.0;
const VAD_MIN_START_RMS: f32 = 0.015;
const VAD_MIN_END_RMS: f32 = 0.008;
const VAD_NOISE_FLOOR_ALPHA: f32 = 0.05;
const VAD_PLAYBACK_GUARD: f32 = 3.0;

pub enum VadAction {
    None,
    StartUtterance,
    EndUtterance,
}

pub struct AutoVad {
    pub in_speech: bool,
    voiced_ms: f32,
    silence_ms: f32,
    noise_floor: f32,
    pub prebuffer: VecDeque<Vec<u8>>,
    pub prebuffer_ms: f32,
}

impl AutoVad {
    pub fn new() -> Self {
        Self {
            in_speech: false,
            voiced_ms: 0.0,
            silence_ms: 0.0,
            noise_floor: 0.005,
            prebuffer: VecDeque::new(),
            prebuffer_ms: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.in_speech = false;
        self.voiced_ms = 0.0;
        self.silence_ms = 0.0;
        self.prebuffer.clear();
        self.prebuffer_ms = 0.0;
    }

    fn frame_rms(frame: &[u8]) -> f32 {
        let samples: Vec<f32> = frame
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect();
        if samples.is_empty() {
            return 0.0;
        }
        (samples.iter().map(|&x| x * x).sum::<f32>() / samples.len() as f32).sqrt()
    }

    fn frame_ms(frame: &[u8]) -> f32 {
        (frame.len() / 2) as f32 / (TARGET_SAMPLE_RATE as f32) * 1000.0
    }

    /// Feed one frame. Returns (send_this_frame, action). When idle, frames
    /// go into the pre-roll buffer; on StartUtterance the caller must flush
    /// `prebuffer` (it already contains this frame).
    pub fn feed(&mut self, frame: Vec<u8>, playback_active: bool) -> (Option<Vec<u8>>, VadAction) {
        let rms = Self::frame_rms(&frame);
        let ms = Self::frame_ms(&frame);

        if !self.in_speech {
            let start_threshold = {
                let base = (self.noise_floor * 3.5).max(VAD_MIN_START_RMS);
                if playback_active {
                    base * VAD_PLAYBACK_GUARD
                } else {
                    base
                }
            };

            // Track the noise floor only from non-voiced frames
            if rms < start_threshold {
                self.noise_floor =
                    self.noise_floor * (1.0 - VAD_NOISE_FLOOR_ALPHA) + rms * VAD_NOISE_FLOOR_ALPHA;
            }

            self.prebuffer_ms += ms;
            self.prebuffer.push_back(frame);
            while self.prebuffer_ms > VAD_PREBUFFER_MS {
                if let Some(front) = self.prebuffer.pop_front() {
                    self.prebuffer_ms -= Self::frame_ms(&front);
                } else {
                    break;
                }
            }

            if rms >= start_threshold {
                self.voiced_ms += ms;
                if self.voiced_ms >= VAD_START_MS {
                    self.in_speech = true;
                    self.voiced_ms = 0.0;
                    self.silence_ms = 0.0;
                    return (None, VadAction::StartUtterance);
                }
            } else {
                self.voiced_ms = 0.0;
            }

            (None, VadAction::None)
        } else {
            let end_threshold = (self.noise_floor * 2.0).max(VAD_MIN_END_RMS);
            if rms < end_threshold {
                self.silence_ms += ms;
            } else {
                self.silence_ms = 0.0;
            }

            if self.silence_ms >= VAD_END_SILENCE_MS {
                self.reset();
                (Some(frame), VadAction::EndUtterance)
            } else {
                (Some(frame), VadAction::None)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One 20ms 16kHz mono frame with the given constant amplitude.
    fn frame(amplitude: i16) -> Vec<u8> {
        (0..320)
            .flat_map(|i| {
                let s = if i % 2 == 0 { amplitude } else { -amplitude };
                s.to_le_bytes()
            })
            .collect()
    }

    const LOUD: i16 = 8000; // rms ≈ 0.24
    const QUIET: i16 = 60; // rms ≈ 0.002

    fn feed_n(vad: &mut AutoVad, amplitude: i16, n: usize, playback: bool) -> Vec<VadAction> {
        (0..n).map(|_| vad.feed(frame(amplitude), playback).1).collect()
    }

    #[test]
    fn triggers_after_sustained_speech_and_keeps_preroll() {
        let mut vad = AutoVad::new();
        let actions = feed_n(&mut vad, LOUD, 3, false); // 60ms voiced
        assert!(matches!(actions[2], VadAction::StartUtterance));
        assert!(vad.in_speech);
        assert!(!vad.prebuffer.is_empty(), "pre-roll must contain the onset");
    }

    #[test]
    fn brief_click_does_not_trigger() {
        let mut vad = AutoVad::new();
        let actions = feed_n(&mut vad, LOUD, 2, false); // only 40ms < VAD_START_MS
        assert!(actions.iter().all(|a| matches!(a, VadAction::None)));
        let actions = feed_n(&mut vad, QUIET, 5, false);
        assert!(actions.iter().all(|a| matches!(a, VadAction::None)));
        assert!(!vad.in_speech);
    }

    #[test]
    fn ends_after_sustained_silence() {
        let mut vad = AutoVad::new();
        feed_n(&mut vad, LOUD, 3, false);
        assert!(vad.in_speech);
        // 900ms of silence = 45 frames of 20ms
        let actions = feed_n(&mut vad, QUIET, 45, false);
        assert!(matches!(actions.last().unwrap(), VadAction::EndUtterance));
        assert!(!vad.in_speech);
    }

    #[test]
    fn speech_resets_silence_countdown() {
        let mut vad = AutoVad::new();
        feed_n(&mut vad, LOUD, 3, false);
        feed_n(&mut vad, QUIET, 40, false); // 800ms silence, not enough
        feed_n(&mut vad, LOUD, 2, false); // speech again resets the countdown
        let actions = feed_n(&mut vad, QUIET, 40, false); // another 800ms
        assert!(actions.iter().all(|a| matches!(a, VadAction::None)));
        assert!(vad.in_speech, "utterance must still be open");
    }

    #[test]
    fn playback_guard_raises_threshold() {
        let mut vad = AutoVad::new();
        // rms ≈ 0.024: above the base threshold (0.015) but below the
        // playback-guarded threshold (0.045)
        let actions = feed_n(&mut vad, 1100, 10, true);
        assert!(actions.iter().all(|a| matches!(a, VadAction::None)));
        assert!(!vad.in_speech);

        // The same signal without playback triggers
        let mut vad = AutoVad::new();
        let actions = feed_n(&mut vad, 1100, 3, false);
        assert!(matches!(actions[2], VadAction::StartUtterance));
    }
}
