import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ConversationState {
  conversation: Message[];
  status: 'Idle' | 'Listening' | 'Thinking' | 'Speaking';
  transcript: string;
}

const useConversation = create<ConversationState>((set) => ({
  conversation: [],
  status: 'Idle',
  transcript: '',
}));

export function VoiceAssistant() {
  const { conversation, status, transcript } = useConversation();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);

    const setupListeners = async () => {
      const unlistenStatus = await listen<ConversationState['status']>('assistant_state', (event) => {
        useConversation.setState({ status: event.payload });
      });

      const unlistenTranscript = await listen<string>('user_transcript', (event) => {
        useConversation.setState({ transcript: event.payload });
      });

      const unlistenResponse = await listen<string>('llm_response', (event) => {
        useConversation.setState((state) => ({
          conversation: [...state.conversation, { role: 'assistant', content: event.payload }],
        }));
      });

      return () => {
        unlistenStatus();
        unlistenTranscript();
        unlistenResponse();
      };
    };

    setupListeners();

  }, []);

  const handleStartRecording = async () => {
    try {
      await invoke('start_recording');
      useConversation.setState({ status: 'Listening', transcript: '' });
    } catch (error) {
      console.error('Failed to start recording:', error);
    }
  };

  const handleStopRecording = async () => {
    try {
      await invoke('stop_recording');
      useConversation.setState({ status: 'Idle' });
    } catch (error) {
      console.error('Failed to stop recording:', error);
    }
  };

  const handleSubmitTranscript = () => {
    if (transcript.trim()) {
      useConversation.setState((state) => ({
        conversation: [...state.conversation, { role: 'user', content: transcript.trim() }],
        transcript: '',
      }));
    }
  };

  if (!mounted) return null;

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{ marginBottom: '20px' }}>Voice Assistant</h1>
        
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '10px',
          marginBottom: '20px',
          padding: '15px',
          backgroundColor: '#f0f0f0',
          borderRadius: '8px'
        }}>
          <button
            onClick={handleStartRecording}
            disabled={status === 'Listening' || status === 'Thinking' || status === 'Speaking'}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              backgroundColor: status === 'Idle' ? '#007AFF' : '#ccc',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: status === 'Idle' ? 'pointer' : 'not-allowed',
            }}
          >
            {status === 'Idle' ? 'Start Recording' : 'Recording...'}
          </button>
          
          <button
            onClick={handleStopRecording}
            disabled={status === 'Idle'}
            style={{
              padding: '10px 20px',
              fontSize: '16px',
              backgroundColor: status !== 'Idle' ? '#007AFF' : '#ccc',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: status !== 'Idle' ? 'pointer' : 'not-allowed',
            }}
          >
            Stop
          </button>
        </div>

        <div style={{ 
          marginBottom: '20px', 
          padding: '10px',
          backgroundColor: '#e8e8e8',
          borderRadius: '4px'
        }}>
          <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '5px' }}>
            Status: {status}
          </div>
          {transcript && (
            <div style={{ fontSize: '14px', color: '#666' }}>
              Partial Transcript: {transcript}
            </div>
          )}
        </div>

        <div style={{ 
          maxHeight: '400px', 
          overflowY: 'auto',
          padding: '15px',
          backgroundColor: '#f8f9fa',
          borderRadius: '4px',
          marginBottom: '20px'
        }}>
          <h3 style={{ marginTop: 0, marginBottom: '15px' }}>Conversation</h3>
          {conversation.length === 0 ? (
            <div style={{ color: '#999', fontStyle: 'italic' }}>
              No conversation yet. Start recording to begin.
            </div>
          ) : (
            conversation.map((msg, index) => (
              <div
                key={index}
                style={{
                  marginBottom: '15px',
                  padding: '10px',
                  backgroundColor: msg.role === 'user' ? '#e3f2fd' : '#ffffff',
                  borderRadius: '8px',
                  borderLeft: `4px solid ${msg.role === 'user' ? '#007AFF' : '#28a745'}`
                }}
              >
                <div style={{ 
                  fontSize: '12px', 
                  fontWeight: 'bold',
                  marginBottom: '5px',
                  color: msg.role === 'user' ? '#007AFF' : '#28a745'
                }}>
                  {msg.role === 'user' ? 'You' : 'Assistant'}
                </div>
                <div style={{ fontSize: '14px', lineHeight: '1.5' }}>
                  {msg.content}
                </div>
              </div>
            ))
          )}
        </div>

        {transcript.trim() && status === 'Listening' && (
          <div style={{ 
            marginTop: '20px',
            padding: '10px',
            backgroundColor: '#fff3cd',
            borderRadius: '4px',
            border: '1px solid #ffc107',
            textAlign: 'center'
          }}>
            <span style={{ fontSize: '14px', marginRight: '10px' }}>
              Transcript: "{transcript}"
            </span>
            <button
              onClick={handleSubmitTranscript}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                backgroundColor: '#007AFF',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Submit
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
