// Script Python do worker de STT (faster-whisper / CTranslate2). Escrito em
// runtime no venv de STT e executado como processo persistente (o modelo fica
// em memória). Protocolo por linhas JSON no stdin/stdout.
//
// Motivo do faster-whisper (e não whisper.cpp): em máquinas com Smart App
// Control ligado, o binário não-assinado do whisper.cpp é BLOQUEADO. O
// faster-whisper roda no Python assinado do sistema e usa o ctranslate2 (wheel
// amplamente distribuído que o SAC aceita) — sem executável não-assinado.

export const STT_WORKER_SOURCE = String.raw`
import sys, os, json

# Protocolo JSON pelo stdout "real"; tudo das libs vai para o stderr.
_real_stdout = sys.stdout
sys.stdout = sys.stderr

def send(obj):
    _real_stdout.write(json.dumps(obj) + "\n")
    _real_stdout.flush()

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

try:
    from faster_whisper import WhisperModel

    name = os.environ.get("STS_STT_MODEL", "small")
    threads = int(os.environ.get("STS_STT_THREADS", "0") or "0")
    send({"log": "Carregando o modelo de transcrição (%s)… (na 1ª vez baixa o modelo)" % name})
    model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)
    send({"ready": True})
except Exception as e:
    send({"error": "Falha ao iniciar o STT: %r" % (e,)})
    sys.exit(1)


def transcribe(req):
    wav = req["wav"]
    lang = req.get("language") or None
    if lang == "auto":
        lang = None
    segments, info = model.transcribe(wav, language=lang, beam_size=1, vad_filter=False)
    return " ".join(s.text for s in segments).strip()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        send({"text": transcribe(req)})
    except Exception as e:
        send({"error": "%r" % (e,)})
`;
