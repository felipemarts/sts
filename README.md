# STS — Fala local (Speech-to-Text + Text-to-Speech)

App desktop (Electron) com **transcrição de fala** e **leitura de texto** rodando
**100% localmente** — nenhum áudio ou texto sai da sua máquina.

- 🎙 **Escutar** — captura o microfone e transcreve em tempo real (VAD por energia)
  usando **Whisper** ([whisper.cpp](https://github.com/ggml-org/whisper.cpp)).
- 🔊 **Ler** — sintetiza texto em voz neural com **[Piper](https://github.com/OHF-Voice/piper1-gpl)**,
  com controle de velocidade e volume, e **exporta o áudio em MP3 ou WAV**.
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
