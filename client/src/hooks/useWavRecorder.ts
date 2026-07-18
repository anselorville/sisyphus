import { useCallback, useEffect, useState } from "react";

interface UseWavRecorderReturn {
  recording: boolean;
  start: () => Promise<void>;
  stop: () => Promise<File | null>;
  error: string | null;
}

/**
 * Hook to record audio from the microphone and encode it as 16-bit PCM WAV.
 * Uses ScriptProcessorNode (deprecated but simpler than AudioWorklet for this case).
 * Returns a File object with type "audio/wav" that can be uploaded directly.
 */
export function useWavRecorder(): UseWavRecorderReturn {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [chunks, setChunks] = useState<Float32Array[]>([]);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);

  // Release the mic if the component unmounts (or a new session replaces the
  // stream/context) while a recording is still in flight -- without this, an
  // abandoned recording leaves the tab's mic indicator on. After a normal
  // stop() these have already been stopped/closed; re-stopping tracks is a
  // no-op and close() on a closed context rejects, hence the swallow.
  useEffect(() => {
    return () => {
      mediaStream?.getTracks().forEach((track) => track.stop());
      audioContext?.close().catch(() => {});
    };
  }, [mediaStream, audioContext]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);

      // ScriptProcessorNode with 4096 buffer size, 1 input channel, 1 output channel
      const scriptProcessor = ctx.createScriptProcessor(4096, 1, 1);

      source.connect(scriptProcessor);
      scriptProcessor.connect(ctx.destination);

      const recordedChunks: Float32Array[] = [];

      scriptProcessor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0);
        // Make a copy of the data since it's reused
        recordedChunks.push(new Float32Array(inputData));
      };

      setAudioContext(ctx);
      setMediaStream(stream);
      setChunks(recordedChunks);
      setRecording(true);
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone permission denied. Check your browser settings."
          : "Failed to access microphone.";
      setError(message);
      setRecording(false);
    }
  }, []);

  const stop = useCallback(async (): Promise<File | null> => {
    setRecording(false);

    if (!audioContext || !mediaStream) {
      return null;
    }

    // Stop all tracks in the stream
    mediaStream.getTracks().forEach((track) => track.stop());

    // Close the audio context
    await audioContext.close();

    // Concatenate all chunks into a single Float32Array
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const concatenated = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      concatenated.set(chunk, offset);
      offset += chunk.length;
    }

    // Convert Float32Array [-1, 1] to 16-bit PCM
    const pcmData = new Int16Array(concatenated.length);
    for (let i = 0; i < concatenated.length; i++) {
      // Clamp to [-1, 1] and convert to 16-bit signed integer
      const sample = Math.max(-1, Math.min(1, concatenated[i]));
      pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    // Create RIFF/WAVE header
    const sampleRate = audioContext.sampleRate;
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;

    const headerLength = 44;
    const dataLength = pcmData.byteLength;
    const fileLength = headerLength + dataLength;

    const header = new ArrayBuffer(headerLength);
    const view = new DataView(header);

    // "RIFF" chunk descriptor
    view.setUint8(0, 0x52); // 'R'
    view.setUint8(1, 0x49); // 'I'
    view.setUint8(2, 0x46); // 'F'
    view.setUint8(3, 0x46); // 'F'
    view.setUint32(4, fileLength - 8, true); // File size - 8

    // "WAVE" format
    view.setUint8(8, 0x57); // 'W'
    view.setUint8(9, 0x41); // 'A'
    view.setUint8(10, 0x56); // 'V'
    view.setUint8(11, 0x45); // 'E'

    // "fmt " subchunk
    view.setUint8(12, 0x66); // 'f'
    view.setUint8(13, 0x6d); // 'm'
    view.setUint8(14, 0x74); // 't'
    view.setUint8(15, 0x20); // ' '
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // Audio format (1 for PCM)
    view.setUint16(22, numChannels, true); // Number of channels
    view.setUint32(24, sampleRate, true); // Sample rate
    view.setUint32(28, byteRate, true); // Byte rate
    view.setUint16(32, blockAlign, true); // Block align
    view.setUint16(34, bitsPerSample, true); // Bits per sample

    // "data" subchunk
    view.setUint8(36, 0x64); // 'd'
    view.setUint8(37, 0x61); // 'a'
    view.setUint8(38, 0x74); // 't'
    view.setUint8(39, 0x61); // 'a'
    view.setUint32(40, dataLength, true); // Subchunk2Size

    // Create the WAV file as a Blob
    const blob = new Blob([header, pcmData.buffer], { type: "audio/wav" });

    // Reset state
    setAudioContext(null);
    setMediaStream(null);
    setChunks([]);

    return new File([blob], "recording.wav", { type: "audio/wav" });
  }, [chunks, audioContext, mediaStream]);

  return {
    recording,
    start,
    stop,
    error,
  };
}
