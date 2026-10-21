@echo off
cd /d "%~dp0"
if not exist "vendor\mediapipe\hand_landmarker.task" (
  echo First run: downloading hand tracking models to vendor\mediapipe ...
  python download_models.py
)
start "" "http://127.0.0.1:8765/"
python server.py 8765
