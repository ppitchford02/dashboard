#!/usr/bin/env python3
"""Download a creator post's audio with the local Chrome session and transcribe it on-device.

Prints JSON only. The audio is stored in a temporary directory and removed before exit.
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON = ROOT / '.transcribe-venv' / 'bin' / 'python'
YTDLP = ROOT / '.transcribe-venv' / 'bin' / 'yt-dlp'


def fail(message):
    print(json.dumps({'ok': False, 'error': message}))
    raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('url')
    parser.add_argument('--browser', default='chrome', choices=['chrome', 'chromium', 'edge', 'firefox', 'safari'])
    # The scheduled-task bridge imposes a short response deadline.  Start with
    # the small English model and a bounded visual sample so a creator video can
    # finish inside that deadline instead of becoming an unusable timeout.
    parser.add_argument('--model', default='tiny.en')
    parser.add_argument('--max-frames', type=int, default=18)
    args = parser.parse_args()
    if not args.url.startswith('https://'):
        fail('A secure post URL is required.')
    if not YTDLP.exists() or not PYTHON.exists():
        fail('The local transcription runtime is not installed.')
    work = pathlib.Path(tempfile.mkdtemp(prefix='sports-picks-audio-'))
    try:
        output = str(work / 'video.%(ext)s')
        ffmpeg = subprocess.run([str(PYTHON), '-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], text=True, capture_output=True, check=True).stdout.strip()
        download = subprocess.run([
            str(YTDLP), '--no-playlist', '--no-warnings', '--cookies-from-browser', args.browser,
            '--ffmpeg-location', ffmpeg, '-f', 'best[height<=480]/best', '-o', output, args.url,
        ], text=True, capture_output=True, timeout=180)
        if download.returncode:
            tail = (download.stderr or download.stdout).strip().splitlines()[-1:] or ['video retrieval failed']
            fail('Could not retrieve creator audio: ' + tail[0])
        video = next(work.glob('video.*'), None)
        if not video:
            fail('The post could not be downloaded.')
        audio = work / 'audio.wav'
        subprocess.run([ffmpeg, '-y', '-i', str(video), '-vn', '-ac', '1', '-ar', '16000', str(audio)], text=True, capture_output=True, timeout=120)
        code = '''
import json, sys
from faster_whisper import WhisperModel
model = WhisperModel(sys.argv[2], device="auto", compute_type="int8")
segments, info = model.transcribe(sys.argv[1], language="en", vad_filter=True)
print(json.dumps({"language":info.language,"segments":[{"start":round(s.start,2),"end":round(s.end,2),"text":s.text.strip()} for s in segments if s.text.strip()]}))
'''
        transcribe = subprocess.run([str(PYTHON), '-c', code, str(audio), args.model], text=True, capture_output=True, timeout=600)
        speech = ''
        segments = []
        if not transcribe.returncode:
            data = json.loads(transcribe.stdout); segments = data['segments']; speech = ' '.join(item['text'] for item in segments).strip()
        frames = work / 'frames'; frames.mkdir()
        subprocess.run([ffmpeg, '-y', '-i', str(video), '-vf', 'fps=1/5,scale=960:-2', str(frames / 'frame-%03d.jpg')], text=True, capture_output=True, timeout=45)
        ocr_code = '''
import json,sys
from rapidocr_onnxruntime import RapidOCR
ocr=RapidOCR(); out=[]
for p in sys.argv[1:]:
 r,_=ocr(p)
 t=' '.join(x[1] for x in (r or [])).strip()
 if t: out.append(t)
print(json.dumps(out))
'''
        frame_paths = [str(p) for p in sorted(frames.glob('*.jpg'))[:args.max_frames]]
        ocr = subprocess.run([str(PYTHON), '-c', ocr_code, *frame_paths], text=True, capture_output=True, timeout=45)
        visual = [] if ocr.returncode else json.loads(ocr.stdout)
        transcript = speech.strip()
        if not transcript and not visual:
            fail('No readable spoken or on-screen creator text was found in this video.')
        print(json.dumps({'ok': True, 'transcript': transcript, 'segments': segments, 'language': 'en', 'visualText': visual, 'engine': 'faster-whisper/' + args.model}))
    except subprocess.TimeoutExpired:
        fail('Video retrieval or transcription timed out.')
    finally:
        shutil.rmtree(work, ignore_errors=True)

if __name__ == '__main__':
    main()
