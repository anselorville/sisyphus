from dataclasses import replace
from email.parser import BytesParser
from email.policy import default

import httpx
import pytest
from pipecat.frames.frames import ErrorFrame, TranscriptionFrame

from app.config import load_settings
from app.minimax_stt_services import MiniMaxSTTService
from app.model_providers import CloudCapabilityConfig, CloudProviderConfig, effective_providers_payload
from app.providers.transcription import _build_cloud_stt


@pytest.mark.parametrize("hint", [None, "zh"])
async def test_transcription_request(monkeypatch, hint):
    settings = replace(load_settings(), minimax_api_key="test-key")
    assert effective_providers_payload(settings)["cloud"]["transcription"]["available_models"]["minimax"] == ["asr-1.0"]
    monkeypatch.setattr("app.providers.transcription.values_for", lambda *_: {"language_hint": hint})
    cloud = CloudProviderConfig(transcription=CloudCapabilityConfig(provider="minimax"))
    service = _build_cloud_stt(settings, cloud)
    audio = b"test audio bytes"

    async def respond(request):
        assert request.method == "POST"
        assert str(request.url) == "https://api.minimax.cn/v1/speech_to_text"
        assert request.headers["Authorization"] == "Bearer test-key"
        assert request.headers.get("language") == hint
        message = BytesParser(policy=default).parsebytes(
            f"Content-Type: {request.headers['Content-Type']}\r\n\r\n".encode() + await request.aread()
        )
        fields = {part.get_param("name", header="content-disposition"): part for part in message.iter_parts()}
        assert fields["model"].get_content() == "asr-1.0"
        assert fields["file"].get_filename() == "utterance.wav"
        assert fields["file"].get_payload(decode=True) == audio
        return httpx.Response(200, json={"text": "  你好  "})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond), headers=service._client.headers) as client:
        await service._client.aclose()
        service._client = client
        frames = [frame async for frame in service.run_stt(audio)]
    assert len(frames) == 1 and isinstance(frames[0], TranscriptionFrame)
    assert frames[0].text == "你好"


@pytest.mark.parametrize("status,body", [(401, {}), (200, {"base_resp": {"status_code": 1004}})])
async def test_provider_errors_are_visible(status, body):
    service = MiniMaxSTTService(api_key="test-key", model="asr-1.0")
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(status, json=body))) as client:
        await service._client.aclose()
        service._client = client
        frames = [frame async for frame in service.run_stt(b"audio")]
    assert len(frames) == 1 and isinstance(frames[0], ErrorFrame)
