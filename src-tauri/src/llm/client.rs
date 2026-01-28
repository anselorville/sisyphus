use anyhow::Result;
use async_openai::{
    types::{ChatCompletionMessageRole, CreateChatCompletionRequestArgs},
    Client,
};
use serde::{Deserialize, Serialize};
use std::env;
use tauri::{Emitter, Manager};

const MIN_CHUNK_TOKENS: usize = 20;
const MAX_CHUNK_TOKENS: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmToken {
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LlmChunk {
    pub content: String,
}

impl LlmChunk {
    pub fn should_emit(&self, token_count: usize, has_punctuation: bool, elapsed_ms: u64) -> bool {
        token_count >= MIN_CHUNK_TOKENS
            || (token_count >= 15 && has_punctuation)
            || elapsed_ms >= 200
    }
}

pub struct LlmClient {
    client: Client<String>,
}

impl LlmClient {
    pub fn new() -> Result<Self> {
        let api_key = env::var("OPENAI_API_KEY")
            .or_else(|| env::var("LLM_API_KEY"))
            .ok_or_else(|| anyhow::anyhow!("LLM API key not found in environment variables"))?;
        
        let client = Client::with_config(
            async_openai::config::OpenAIConfig::default().with_api_key(api_key),
        );
        
        Ok(Self { client })
    }
    
    pub async fn stream_completion(
        &self,
        messages: &[async_openai::types::ChatCompletionMessage],
    ) -> Result<(String, Vec<LlmChunk>)> {
        let mut full_response = String::new();
        let mut chunks: Vec<LlmChunk> = Vec::new();
        let mut current_chunk = String::new();
        let mut token_count = 0;
        let start_time = std::time::Instant::now();
        
        let args = CreateChatCompletionRequestArgs::default();
        
        let mut stream = self.client.chat().create_stream(
            messages.to_vec(),
            args
                .model("gpt-3.5-turbo")
                .temperature(0.7)
                .max_tokens(200)
                .stream(true),
        )
        .await?;
        
        while let Some(result) = stream.next().await {
            let delta = match result {
                Ok(response) => response.choices.first().and_then(|c| c.delta.content.as_ref()),
                Err(e) => return Err(anyhow::anyhow!("LLM stream error: {}", e)),
            };
            
            if let Some(content) = delta {
                full_response.push_str(content);
                current_chunk.push_str(content);
                token_count += content.len();
                
                let has_punctuation = content.contains('.') 
                    || content.contains(',')
                    || content.contains('!')
                    || content.contains('?');
                
                let elapsed = start_time.elapsed().as_millis();
                
                if LlmChunk::should_emit(&current_chunk, token_count, has_punctuation, elapsed) {
                    chunks.push(LlmChunk {
                        content: current_chunk.clone(),
                    });
                    
                    current_chunk.clear();
                    token_count = 0;
                    start_time = std::time::Instant::now();
                }
            }
        }
        
        if !current_chunk.is_empty() {
            chunks.push(LlmChunk {
                content: current_chunk.clone(),
            });
        }
        
        Ok((full_response, chunks))
    }
}

#[tauri::command]
pub async fn send_llm_request(
    state: tauri::State<'_, Arc<Mutex<LlmClient>>>,
    user_message: String,
) -> Result<String, String> {
    let client = state.lock().unwrap();
    
    let messages = vec![async_openai::types::ChatCompletionMessageArgs::default()
        .role(ChatCompletionMessageRole::User)
        .content(user_message)];
    
    match client.stream_completion(&messages).await {
        Ok((full_response, chunks)) => Ok(full_response),
        Err(e) => Err(format!("LLM request failed: {}", e)),
    }
}

#[tauri::command]
pub async fn stream_llm_response<M: Manager + Clone>(
    app: tauri::AppHandle<M>,
    state: tauri::State<'_, Arc<Mutex<LlmClient>>>,
    user_message: String,
) -> Result<(), String> {
    let client = state.lock().unwrap();
    
    let conversation_history = tauri::async_command::get_conversation_history();
    
    let messages: Vec<async_openai::types::ChatCompletionMessageArgs> = conversation_history
        .iter()
        .map(|msg| {
            let role = match msg.role {
                conversation::Role::User => ChatCompletionMessageRole::User,
                conversation::Role::Assistant => ChatCompletionMessageRole::Assistant,
            };
            
            ChatCompletionMessageArgs::default()
                .role(role)
                .content(msg.content.clone())
        })
        .collect();
    
    let user_msg = ChatCompletionMessageArgs::default()
        .role(ChatCompletionMessageRole::User)
        .content(user_message);
    
    let all_messages = [messages, vec![user_msg]].concat();
    
    match client.stream_completion(&all_messages).await {
        Ok((full_response, chunks)) => {
            app.emit("llm_complete", full_response)
                .map_err(|e| format!("Failed to emit event: {}", e))?;
            
            for chunk in chunks {
                app.emit("llm_chunk", chunk)
                    .map_err(|e| format!("Failed to emit event: {}", e))?;
            }
            
            Ok(())
        }
        Err(e) => Err(format!("LLM stream failed: {}", e)),
    }
}
