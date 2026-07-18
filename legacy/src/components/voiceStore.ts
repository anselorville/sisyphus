import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export type ConversationStatus = 'Idle' | 'Listening' | 'FinalizingASR' | 'Thinking' | 'Speaking';
export type ServiceStatus =
  | 'offline'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'reconnecting'
  | 'error';

interface ConversationState {
  conversation: Message[];
  status: ConversationStatus;
  serviceStatus: ServiceStatus;
  serviceMessage: string;
  autoVad: boolean;
  micOpen: boolean;
  playbackPaused: boolean;
  transcript: string;
  audioLevel: number;
  pendingAssistantResponse: string;
  llmBusy: boolean;
  utteranceQueue: string[];
  errorBanner: string;
  addMessage: (message: Message) => void;
  setStatus: (status: ConversationStatus) => void;
  setServiceStatus: (status: ServiceStatus, message: string) => void;
  setAutoVad: (auto: boolean) => void;
  setMicOpen: (open: boolean) => void;
  setPlaybackPaused: (paused: boolean) => void;
  setTranscript: (transcript: string) => void;
  setAudioLevel: (level: number) => void;
  setErrorBanner: (message: string) => void;
  appendAssistantResponse: (chunk: string, isComplete: boolean) => void;
  enqueueUtterance: (text: string) => void;
  dequeueUtterance: () => string | undefined;
  setLlmBusy: (busy: boolean) => void;
}

export const useConversation = create<ConversationState>((set, get) => ({
  conversation: [],
  status: 'Idle',
  serviceStatus: 'offline',
  serviceMessage: '',
  autoVad: false,
  micOpen: false,
  playbackPaused: false,
  transcript: '',
  audioLevel: 0,
  pendingAssistantResponse: '',
  llmBusy: false,
  utteranceQueue: [],
  errorBanner: '',
  addMessage: (message) => set((s) => ({ conversation: [...s.conversation, message] })),
  setStatus: (status) => set({ status }),
  setServiceStatus: (serviceStatus, serviceMessage) => set({ serviceStatus, serviceMessage }),
  setAutoVad: (autoVad) => set({ autoVad }),
  setMicOpen: (micOpen) => set({ micOpen }),
  setPlaybackPaused: (playbackPaused) => set({ playbackPaused }),
  setTranscript: (transcript) => set({ transcript }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  setErrorBanner: (errorBanner) => set({ errorBanner }),
  appendAssistantResponse: (chunk, isComplete) => {
    if (isComplete) {
      const pending = get().pendingAssistantResponse + chunk;
      if (pending.trim()) {
        set((s) => ({
          conversation: [...s.conversation, { role: 'assistant', content: pending.trim() }],
          pendingAssistantResponse: '',
        }));
      } else {
        set({ pendingAssistantResponse: '' });
      }
    } else {
      set((s) => ({ pendingAssistantResponse: s.pendingAssistantResponse + chunk }));
    }
  },
  enqueueUtterance: (text) => set((s) => ({ utteranceQueue: [...s.utteranceQueue, text] })),
  dequeueUtterance: () => {
    const [next, ...rest] = get().utteranceQueue;
    set({ utteranceQueue: rest });
    return next;
  },
  setLlmBusy: (llmBusy) => set({ llmBusy }),
}));

// Serialize LLM turns: mic toggling only produces utterances; each utterance
// runs through LLM+TTS in order without blocking the mic.
export async function pumpLlmQueue() {
  const state = useConversation.getState();
  if (state.llmBusy) return;

  const next = state.dequeueUtterance();
  if (next === undefined) return;

  state.setLlmBusy(true);
  try {
    await invoke('stream_llm_response', { userMessage: next });
  } catch (error) {
    console.error('LLM error:', error);
    useConversation.getState().setErrorBanner(`LLM 请求失败: ${error}`);
  } finally {
    useConversation.getState().setLlmBusy(false);
    void pumpLlmQueue();
  }
}
