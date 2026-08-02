# STS — Fala local (Speech-to-Text + Text-to-Speech)

App desktop (Electron) com **transcrição de fala** e **leitura de texto** rodando
**100% localmente** — nenhum áudio ou texto sai da sua máquina.

- 🎙 **Escutar** — captura o microfone e transcreve em tempo real (VAD por energia)
  usando **Whisper** ([whisper.cpp](https://github.com/ggml-org/whisper.cpp)).
- 🔊 **Ler** — sintetiza texto em voz neural com **[Piper](https://github.com/OHF-Voice/piper1-gpl)**,
  com controle de velocidade e volume, e **exporta o áudio em MP3 ou WAV**.
- 🧬 **Clonar** — grava uma amostra da sua voz e sintetiza qualquer texto com ela,
  usando **[Chatterbox](https://github.com/resemble-ai/chatterbox)** (licença MIT).
  Recurso avançado e mais pesado (ver abaixo).
- ⚙ **Gerenciador de modelos** — baixa, guarda e remove modelos Whisper e vozes
  Piper (vários idiomas) pela própria interface.

> Modelos, vozes e o ambiente Python do Piper ficam na pasta `userData` do app —
> **nada disso é versionado no repositório**.

## Pré-requisitos

- **Node.js 18+** e npm
- **whisper.cpp** (fornece o binário `whisper-server`)
  - macOS: `brew install whisper-cpp`
  - O app procura `whisper-server` no `PATH` e em locais comuns; você também pode
    apontar o caminho manualmente em **Configurações**.
- **Python 3.9+** (o app cria um _venv_ isolado e instala o `piper-tts` sozinho
  ao clicar em **Instalar Piper**)
- **ffmpeg** (opcional, só para exportar em **MP3** — WAV não precisa)
  - macOS: `brew install ffmpeg`
- **Python 3.11** (opcional, só para a **Clonagem de voz**)
  - macOS: `brew install python@3.11`
  - O app cria um _venv_ separado e instala o `chatterbox-tts` (+ PyTorch, ~2–3 GB)

## Rodando em desenvolvimento

```bash
npm install
npm start
```

### Primeiro uso

1. Abra a aba **Configurações**.
2. Em **Motores**, confirme que o whisper.cpp foi encontrado e clique em
   **Instalar Piper** (cria o venv + instala o `piper-tts`).
3. Baixe pelo menos **um modelo Whisper** (ex.: _Large v3 Turbo_) e **uma voz Piper**
   (ex.: _Português BR — Faber_).
4. Selecione o **modelo de transcrição ativo** e permita o **microfone**.
5. Vá para **Escutar** e clique em **Iniciar captura**, ou para **Ler** e digite um texto.

## Clonagem de voz (avançado)

A aba **Clonar** usa o [Chatterbox](https://github.com/resemble-ai/chatterbox) (MIT)
para clonagem _zero-shot_: sintetiza texto imitando o timbre de uma amostra curta.

1. Instale o **Python 3.11** (`brew install python@3.11`).
2. Na aba **Clonar**, clique em **Instalar clonagem** — cria um _venv_ separado e
   baixa `chatterbox-tts` + PyTorch (~2–3 GB). O modelo (~1 GB) é baixado do
   HuggingFace no primeiro uso.
3. **Grave ~10s** da voz (fale naturalmente, sem ruído de fundo).
4. Escolha o idioma, digite o texto e clique em **Ler com voz clonada** ou **Salvar…**.

> **Desempenho:** roda em **CPU** por padrão (em Apple Silicon o MPS ficou ~8x
> mais lento por _fallback_). Espere ~30s para carregar o modelo (uma vez por
> sessão) e **~1–2 min por frase**. Dá para experimentar `STS_CLONE_DEVICE=mps`.
>
> Tudo (venv, cache de modelos, amostra) fica em `userData`, fora do repositório.
> Os pesos do Chatterbox são MIT.

## Empacotando

```bash
npm run make
```

> Observação: o empacotamento atual **não** embute o `whisper.cpp` nem o Python —
> eles são resolvidos do ambiente. Embutir os binários é um passo futuro para
> distribuição standalone.

## Arquitetura

| Camada | Papel |
| --- | --- |
| `src/main.ts` | Processo principal do Electron: janela, permissões, IPC |
| `src/backend/` | Engines (Whisper/Piper), gerenciador de modelos, venv, settings |
| `src/preload.ts` | Ponte segura `window.sts` (contextIsolation) |
| `src/ui/` | Renderer: abas Escutar/Ler/Configurações, captura + VAD |
| `src/shared/` | Tipos e contrato de IPC compartilhados |

- **STT:** o renderer captura PCM 16 kHz mono, um VAD por energia recorta segmentos
  de fala e os envia ao `whisper-server` (modelo carregado em memória) via IPC.
- **TTS:** o texto é sintetizado pelo Piper (no venv) em um WAV; a velocidade usa o
  `length_scale` do Piper e o volume é aplicado no playback (Web Audio).

## Privacidade

Todo o processamento é local. O único acesso à rede é o **download de modelos**
(HuggingFace), feito sob demanda quando você clica em baixar.

## Licença

MIT
