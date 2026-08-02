// Script Python do worker de clonagem (Chatterbox). É escrito em runtime para
// o venv de clonagem e executado como processo persistente (o modelo fica na
// memória). Comunicação por linhas JSON no stdin/stdout.
//
// IMPORTANTE:
// - bibliotecas (torch/transformers/HF) imprimem no stdout e corromperiam o
//   protocolo, então redirecionamos o stdout delas para o stderr e usamos um
//   descriptor separado só para as mensagens JSON.
// - Device padrão = CPU. Em Apple Silicon o MPS ficou ~8x MAIS LENTO (fallback
//   constante p/ CPU). Dá para forçar outro via STS_CLONE_DEVICE=mps|cuda.

export const CLONE_WORKER_SOURCE = String.raw`
import sys, os, json

# Protocolo JSON vai pelo stdout "real"; tudo das libs vai para o stderr.
_real_stdout = sys.stdout
sys.stdout = sys.stderr

def send(obj):
    _real_stdout.write(json.dumps(obj) + "\n")
    _real_stdout.flush()

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

try:
    import torch
    import torchaudio

    try:
        torch.set_num_threads(os.cpu_count() or 4)
    except Exception:
        pass

    device = os.environ.get("STS_CLONE_DEVICE") or "cpu"
    send({"log": "Carregando o modelo de clonagem (%s)… pode levar ~30s." % device})

    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    try:
        model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    except Exception as e:
        send({"log": "Falha em %s (%r); usando CPU…" % (device, e)})
        device = "cpu"
        model = ChatterboxMultilingualTTS.from_pretrained(device=device)

    sr = int(getattr(model, "sr", 24000))
    send({"ready": True})
except Exception as e:
    send({"error": "Falha ao iniciar a clonagem: %r" % (e,)})
    sys.exit(1)


def synth(req):
    text = req["text"]
    ref = req["ref"]
    language = req.get("language", "pt")
    out = req["out"]
    # assinatura confirmada: generate(text, language_id, audio_prompt_path=None, ...)
    wav = model.generate(text, language_id=language, audio_prompt_path=ref)
    t = wav if hasattr(wav, "dim") else torch.tensor(wav)
    t = t.detach().to("cpu")
    if t.dim() == 1:
        t = t.unsqueeze(0)
    torchaudio.save(out, t, sr)


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        synth(req)
        send({"ok": True})
    except Exception as e:
        send({"error": "%r" % (e,)})
`;
