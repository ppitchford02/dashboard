import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


class VideoProvenanceTests(unittest.TestCase):
    def test_actual_cli_does_not_mix_ocr_into_speech(self):
        script = Path(__file__).resolve().parents[1] / 'bin/transcribe-social-video.py'
        spec = importlib.util.spec_from_file_location('transcribe_social_video', script)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); work = root/'work'; work.mkdir()
            executable = root/'runtime'; executable.touch()
            def run(command, **kwargs):
                text = ''
                if 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())' in command:
                    text = '/fake/ffmpeg'
                elif '--no-playlist' in command:
                    (work/'video.mp4').touch()
                elif any('from faster_whisper import' in str(arg) for arg in command):
                    text = json.dumps({'language':'en','segments':[{'start':0,'end':2,'text':'Spoken recommendation'}]})
                elif any('from rapidocr_onnxruntime import' in str(arg) for arg in command):
                    text = json.dumps(['Different visual line'])
                return subprocess.CompletedProcess(command, 0, text, '')
            output = io.StringIO()
            with patch.object(module,'PYTHON',executable), patch.object(module,'YTDLP',executable), patch.object(module.tempfile,'mkdtemp',return_value=str(work)), patch.object(module.subprocess,'run',side_effect=run), patch('sys.argv',[str(script),'https://example.com/video']), contextlib.redirect_stdout(output):
                module.main()
            result = json.loads(output.getvalue())
            self.assertEqual(result['transcript'],'Spoken recommendation')
            self.assertEqual(result['visualText'],['Different visual line'])
            self.assertEqual(result['engine'],'faster-whisper/tiny.en')
            self.assertFalse(work.exists())
