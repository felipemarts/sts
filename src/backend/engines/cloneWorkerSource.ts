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
import sys, os, json, re

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

# Cache da referência: codificar o audio_prompt (~6s timbre/10s prosódia) é caro;
# como o mesmo worker gera várias frases da MESMA amostra, só recodifica se mudar.
_last_ref = None
_last_exag = None


# Quebra o texto em blocos de ~max_chars, respeitando frases. O Chatterbox tem
# teto rígido (~40s / 1000 tokens): textos longos são CORTADOS e sofrem "drift"
# (fala enrolada, alucinação) acima de ~300-1000 chars. Gerar por frase e
# concatenar resolve. Não fragmentar demais (1 palavra vira ruído): agrupamos
# frases curtas até o teto.
def split_text(text, max_chars=160):
    text = (text or "").strip()
    if len(text) <= max_chars:
        return [text] if text else []
    chunks = []
    cur = ""
    def push():
        nonlocal cur
        if cur.strip():
            chunks.append(cur.strip())
        cur = ""
    for sent in re.split(r"(?<=[.!?…])\s+", text):
        sent = sent.strip()
        if not sent:
            continue
        if len(sent) > max_chars:
            push()
            for part in re.split(r"(?<=[,;:])\s+", sent):
                part = part.strip()
                if not part:
                    continue
                if cur and len(cur) + 1 + len(part) > max_chars:
                    push()
                cur = (cur + " " + part).strip() if cur else part
            push()
        else:
            if cur and len(cur) + 1 + len(sent) > max_chars:
                push()
            cur = (cur + " " + sent).strip() if cur else sent
    push()
    return chunks


def synth(req):
    text = req["text"]
    ref = req["ref"]
    language = req.get("language", "pt")
    out = req["out"]
    # Parâmetros calibrados (empírico + docs do Chatterbox): cfg_weight baixo
    # (~0.3) deixa a fala mais lenta e ARTICULADA; temperature < 0.8 reduz o
    # embolamento; exaggeration alto acelera/desestabiliza — manter ~0.5.
    exaggeration = float(req.get("exaggeration", 0.5))
    cfg_weight = float(req.get("cfg_weight", 0.3))
    temperature = float(req.get("temperature", 0.6))
    repetition_penalty = float(req.get("repetition_penalty", 2.0))

    chunks = split_text(text)
    if not chunks:
        raise ValueError("texto vazio")

    # Codifica a referência só quando muda (reaproveita entre frases).
    global _last_ref, _last_exag
    if ref != _last_ref or exaggeration != _last_exag:
        model.prepare_conditionals(ref, exaggeration=exaggeration)
        _last_ref = ref
        _last_exag = exaggeration

    gap = torch.zeros(1, int(sr * 0.25))  # 250ms de silêncio entre frases
    pieces = []
    for i, chunk in enumerate(chunks):
        if len(chunks) > 1:
            send({"log": "Sintetizando frase %d de %d…" % (i + 1, len(chunks))})
        wav = model.generate(
            chunk,
            language_id=language,
            audio_prompt_path=None,  # reusa os conds já preparados
            exaggeration=exaggeration,
            cfg_weight=cfg_weight,
            temperature=temperature,
            repetition_penalty=repetition_penalty,
        )
        t = wav if hasattr(wav, "dim") else torch.tensor(wav)
        t = t.detach().to("cpu")
        if t.dim() == 1:
            t = t.unsqueeze(0)
        pieces.append(t)
        if i < len(chunks) - 1:
            pieces.append(gap)
    torchaudio.save(out, torch.cat(pieces, dim=1), sr)


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
