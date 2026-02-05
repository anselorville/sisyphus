use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioRawFrame {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextFrame {
    pub text: String,
    pub is_final: bool,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ControlFrame {
    Start,
    Stop,
    Cancel,
    Metadata { key: String, value: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Frame {
    Audio(AudioRawFrame),
    Text(TextFrame),
    Control(ControlFrame),
}
