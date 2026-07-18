import { useEffect, useState, useCallback } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

import {
  ConversationStatus,
  ServiceStatus,
  pumpLlmQueue,
  useConversation,
} from './voiceStore';

const SERVICE_LABELS: Record<ServiceStatus, string> = {
  offline: '服务未启动',
  starting: '启动中…',
  ready: '服务就绪',
  degraded: '文字模式',
  reconnecting: '重连中…',
  error: '服务异常',
};

const SERVICE_COLORS: Record<ServiceStatus, string> = {
  offline: '#999',
  starting: '#ff9800',
  ready: '#28a745',
  degraded: '#ff9800',
  reconnecting: '#ff9800',
  error: '#dc3545',
};

const btn = (bg: string, disabled = false): React.CSSProperties => ({
  padding: '10px 20px',
  fontSize: '15px',
  backgroundColor: disabled ? '#ccc' : bg,
  color: 'white',
  border: 'none',
  borderRadius: '20px',
  cursor: disabled ? 'not-allowed' : 'pointer',
});

export function VoiceAssistant() {
  const {
    conversation,
    status,
    serviceStatus,
    serviceMessage,
    autoVad,
    micOpen,
    playbackPaused,
    transcript,
    audioLevel,
    pendingAssistantResponse,
    utteranceQueue,
    errorBanner,
  } = useConversation();

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const unlisteners: UnlistenFn[] = [];
    const store = () => useConversation.getState();

    const setupListeners = async () => {
      unlisteners.push(
        await listen<{ status: ServiceStatus; message: string }>(
          'voice_assistant:service_status',
          (e) => {
            store().setServiceStatus(e.payload.status, e.payload.message);
            if (e.payload.status === 'offline' || e.payload.status === 'error') {
              store().setMicOpen(false);
            }
          }
        )
      );

      unlisteners.push(
        await listen<{ state: ConversationStatus }>('voice_assistant:state_changed', (e) => {
          // While the mic is open, ignore Idle from playback completion —
          // pipeline states run in parallel with capture now.
          if (e.payload.state === 'Idle' && store().micOpen) return;
          store().setStatus(e.payload.state);
        })
      );

      // In auto-VAD mode the backend detects speech; mirror it in the UI
      unlisteners.push(
        await listen<{ status: string }>('voice_assistant:vad_status', (e) => {
          if (e.payload.status === 'speech_start') store().setMicOpen(true);
          if (e.payload.status === 'speech_end') store().setMicOpen(false);
        })
      );

      unlisteners.push(
        await listen<{ auto: boolean }>('voice_assistant:vad_mode', (e) => {
          store().setAutoVad(e.payload.auto);
        })
      );

      unlisteners.push(
        await listen<{ partial: string; final: string | null }>(
          'voice_assistant:user_transcript',
          (e) => {
            const { partial, final } = e.payload;
            if (final) store().setTranscript(final);
            else if (partial) store().setTranscript(partial);
          }
        )
      );

      // Authoritative end-of-utterance text (with punctuation) → LLM queue
      unlisteners.push(
        await listen<{ text: string }>('voice_assistant:utterance_final', (e) => {
          const s = store();
          const text = (e.payload.text || s.transcript).trim();
          s.setTranscript('');
          if (!text) {
            if (!s.micOpen) s.setStatus('Idle');
            return;
          }
          s.addMessage({ role: 'user', content: text });
          s.enqueueUtterance(text);
          void pumpLlmQueue();
        })
      );

      unlisteners.push(
        await listen<{ content: string; is_complete: boolean }>(
          'voice_assistant:assistant_response',
          (e) => store().appendAssistantResponse(e.payload.content, e.payload.is_complete)
        )
      );

      unlisteners.push(
        await listen<{ level: number }>('voice_assistant:audio_level', (e) =>
          store().setAudioLevel(e.payload.level)
        )
      );

      unlisteners.push(
        await listen('voice_assistant:playback_paused', () => store().setPlaybackPaused(true))
      );
      unlisteners.push(
        await listen('voice_assistant:playback_resumed', () => store().setPlaybackPaused(false))
      );

      unlisteners.push(
        await listen<{ code: string; message: string }>('voice_assistant:error', (e) => {
          store().setErrorBanner(`${e.payload.code}: ${e.payload.message}`);
        })
      );
    };

    setupListeners();
    return () => unlisteners.forEach((u) => u());
  }, []);

  const handleToggleService = useCallback(async () => {
    const s = useConversation.getState();
    s.setErrorBanner('');
    try {
      if (s.serviceStatus === 'offline' || s.serviceStatus === 'error') {
        s.setServiceStatus('starting', '正在启动语音服务');
        await invoke('start_voice_service');
      } else {
        s.setMicOpen(false);
        await invoke('stop_voice_service');
      }
    } catch (error) {
      s.setServiceStatus('error', String(error));
    }
  }, []);

  const handleToggleMic = useCallback(async () => {
    const s = useConversation.getState();
    const usable = s.serviceStatus === 'ready' || s.serviceStatus === 'degraded';
    if (!usable || s.autoVad) return;
    try {
      if (s.micOpen) {
        s.setMicOpen(false);
        await invoke('close_mic');
      } else {
        s.setTranscript('');
        s.setMicOpen(true);
        await invoke('open_mic');
      }
    } catch (error) {
      console.error('Mic toggle failed:', error);
      s.setMicOpen(false);
    }
  }, []);

  const handleToggleAutoVad = useCallback(async () => {
    const s = useConversation.getState();
    try {
      await invoke('set_vad_mode', { auto: !s.autoVad });
    } catch (error) {
      s.setErrorBanner(`切换模式失败: ${error}`);
    }
  }, []);

  if (!mounted) return null;

  const serviceOn = serviceStatus !== 'offline' && serviceStatus !== 'error';
  const micDisabled = serviceStatus !== 'ready' && serviceStatus !== 'degraded';

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '760px', margin: '0 auto' }}>
      {/* Header: title + service switch (top-right) */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '24px' }}>Voice Assistant</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span
            style={{ fontSize: '13px', color: SERVICE_COLORS[serviceStatus], fontWeight: 'bold' }}
            title={serviceMessage}
          >
            ● {SERVICE_LABELS[serviceStatus]}
          </span>
          <button
            onClick={handleToggleService}
            disabled={serviceStatus === 'starting'}
            style={btn(serviceOn ? '#dc3545' : '#28a745', serviceStatus === 'starting')}
          >
            {serviceOn ? '停止服务' : '启动服务'}
          </button>
        </div>
      </div>

      {serviceStatus === 'degraded' && (
        <div
          style={{
            marginBottom: '12px',
            padding: '8px 14px',
            backgroundColor: '#fff3cd',
            color: '#856404',
            borderRadius: '6px',
            fontSize: '13px',
          }}
        >
          {serviceMessage}
        </div>
      )}

      {errorBanner && (
        <div
          style={{
            marginBottom: '12px',
            padding: '10px 14px',
            backgroundColor: '#f8d7da',
            color: '#721c24',
            borderRadius: '6px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: '13px',
          }}
        >
          <span>{errorBanner}</span>
          <button
            onClick={() => useConversation.getState().setErrorBanner('')}
            style={{
              background: 'none',
              border: 'none',
              color: '#721c24',
              cursor: 'pointer',
              fontSize: '16px',
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Mic / VAD control */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
          marginBottom: '16px',
          padding: '14px',
          backgroundColor: '#f0f0f0',
          borderRadius: '10px',
        }}
      >
        {autoVad ? (
          <span
            style={{
              padding: '10px 20px',
              fontSize: '15px',
              borderRadius: '20px',
              backgroundColor: micOpen ? '#dc3545' : '#28a745',
              color: 'white',
              fontWeight: 'bold',
            }}
          >
            {micOpen ? '🎙 检测到语音…' : '👂 自动聆听中'}
          </span>
        ) : (
          <button onClick={handleToggleMic} disabled={micDisabled} style={btn(micOpen ? '#dc3545' : '#007AFF', micDisabled)}>
            {micOpen ? '🎙 关闭话筒（说完了）' : '🎙 打开话筒'}
          </button>
        )}

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '13px',
            cursor: serviceOn ? 'pointer' : 'not-allowed',
            color: serviceOn ? '#333' : '#999',
          }}
        >
          <input
            type="checkbox"
            checked={autoVad}
            disabled={!serviceOn}
            onChange={handleToggleAutoVad}
          />
          自动检测（免按键）
        </label>

        {(micOpen || autoVad) && (
          <div
            style={{
              width: '100px',
              height: '10px',
              backgroundColor: '#ddd',
              borderRadius: '5px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.min(audioLevel * 300, 100)}%`,
                height: '100%',
                backgroundColor: micOpen ? '#dc3545' : '#007AFF',
                transition: 'width 0.1s ease-out',
              }}
            />
          </div>
        )}

        {playbackPaused && (
          <span style={{ fontSize: '13px', color: '#ff9800', fontWeight: 'bold' }}>
            ⏸ 播放已暂停（缓存中）
          </span>
        )}
        {utteranceQueue.length > 0 && (
          <span style={{ fontSize: '13px', color: '#666' }}>
            队列 {utteranceQueue.length} 句待处理
          </span>
        )}
      </div>

      {/* Pipeline status */}
      <div
        style={{ marginBottom: '16px', padding: '10px', backgroundColor: '#e8e8e8', borderRadius: '6px' }}
      >
        <div style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '4px' }}>
          Status: {status}
          {micOpen ? '（话筒开启）' : ''}
        </div>
        {transcript && <div style={{ fontSize: '14px', color: '#666' }}>识别中: {transcript}</div>}
        {pendingAssistantResponse && (
          <div style={{ fontSize: '14px', color: '#28a745', marginTop: '4px' }}>
            Assistant: {pendingAssistantResponse}
          </div>
        )}
      </div>

      {/* Conversation history */}
      <div
        style={{
          maxHeight: '420px',
          overflowY: 'auto',
          padding: '14px',
          backgroundColor: '#f8f9fa',
          borderRadius: '6px',
        }}
      >
        <h3 style={{ marginTop: 0, marginBottom: '12px' }}>Conversation</h3>
        {conversation.length === 0 ? (
          <div style={{ color: '#999', fontStyle: 'italic' }}>
            启动服务后打开话筒（或勾选自动检测）开始对话。
          </div>
        ) : (
          conversation.map((msg, index) => (
            <div
              key={index}
              style={{
                marginBottom: '12px',
                padding: '10px',
                backgroundColor: msg.role === 'user' ? '#e3f2fd' : '#ffffff',
                borderRadius: '8px',
                borderLeft: `4px solid ${msg.role === 'user' ? '#007AFF' : '#28a745'}`,
              }}
            >
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 'bold',
                  marginBottom: '4px',
                  color: msg.role === 'user' ? '#007AFF' : '#28a745',
                }}
              >
                {msg.role === 'user' ? 'You' : 'Assistant'}
              </div>
              <div style={{ fontSize: '14px', lineHeight: '1.5' }}>{msg.content}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
