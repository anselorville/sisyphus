@echo off
echo ========================================
echo Starting Inference Services
echo ========================================
echo.

echo [1/2] Starting ASR service in venv...
cmd /c "inference\venv\Scripts\activate.bat && python inference\run_asr.py"
echo.

echo [2/2] Starting TTS service in venv-tts...
cmd /c "inference\venv-tts\Scripts\activate.bat && python inference\run_tts.py"
echo.

echo Both services started in separate windows.
echo Press any key in this window to close this helper.
pause >nul
