# STS — Fala local (Speech-to-Text + Text-to-Speech)

App desktop (Electron) com **transcrição de fala** e **leitura de texto**.
O foco é **funcionar sem configuração manual**: o app baixa sozinho tudo que
precisa (Python embutido, modelos e vozes) na pasta `userData` — nada é
instalado no sistema nem versionado no repositório.

- 🎙 **Escutar** — captura o microfone e transcreve (VAD por energia) usando
  **Whisper** ([whisper.cpp](https://github.com/ggml-org/whisper.cpp)). O binário
  é **baixado automaticamente** no Windows e no Linux; no macOS usa o
  `whisper-cli` do Homebrew.
- 🔊 **Ler** — sintetiza texto em voz neural com dois motores:
  - **Neural (Edge)** — vozes neurais da Microsoft (as mesmas do Azure),
    **grátis, sem instalação**, funciona na hora (precisa de internet). É o padrão.
  - **Local (Piper)** — [Piper](https://github.com/OHF-Voice/piper1-gpl), **100%
    offline**. Instala-se em 1 clique (o app baixa um Python embutido + o
    `piper-tts`, sem depender de Python do sistema).
  - Exporta o áudio em **MP3 ou WAV**.
- ⚙ **Gerenciador de modelos** — baixa, guarda e remove modelos Whisper e vozes
  Piper (vários idiomas) pela própria interface.

## Instalando a partir de um release

Baixe o pacote da sua plataforma em
[Releases](https://github.com/felipemarts/sts/releases).

### macOS — primeira abertura (e a cada atualização)

O app é assinado **ad-hoc** (sem Apple Developer ID, sem notarização), então o
Gatekeeper bloqueia a abertura de um `.zip` baixado da internet com o aviso:

> **O Item sts Não Foi Aberto** — A Apple não pôde verificar se o item sts está
> livre de algum malware capaz de danificar o Mac ou comprometer sua privacidade.

Não clique em **Mover para o Lixo**: clique em **OK**. Depois de descompactar e
mover o `STS.app` para `/Applications`, remova a quarentena:

```bash
xattr -dr com.apple.quarantine /Applications/STS.app
```

Alternativa sem terminal: tente abrir, então vá em **Ajustes do Sistema ›
Privacidade e Segurança** e clique em **Abrir mesmo assim**.

Isso vale **para toda versão nova baixada**, não só para a primeira instalação:
ao atualizar, o `.zip` novo vem com a quarentena de novo e o aviso volta.

> Se você baixou o **0.2.0**, ele saiu com a assinatura corrompida e o macOS
> dizia que o app estava _danificado_ — nesse caso nem o "Abrir mesmo assim"
> funcionava. Corrigido a partir do **0.2.1**; baixe a versão nova.

Windows e Linux não precisam de nenhum passo extra.

## Pré-requisitos

- **Node.js 18+** e npm (só para desenvolvimento).
- **Internet** na primeira vez (para baixar binários/modelos) e para o TTS Edge.
- **macOS apenas:** o binário do whisper.cpp não é publicado para macOS; instale
  com `brew install whisper-cpp` (ou aponte o caminho do binário em
  **Configurações**). No Windows e no Linux o app baixa o binário sozinho.

> Não é preciso instalar Python, whisper.cpp (fora do macOS) nem nada mais: o app
> resolve tudo sob demanda.

## Rodando em desenvolvimento

```bash
npm install
npm start
```

### Primeiro uso

1. Abra a aba **Configurações**.
2. Em **Motores › Transcrição (STT)**, clique em **Instalar Whisper** (baixa o
   binário — ~30 MB, uma vez só). No macOS, garanta o `brew install whisper-cpp`.
3. Baixe pelo menos **um modelo Whisper** (ex.: _Large v3 Turbo_).
4. Selecione o **modelo de transcrição ativo** e permita o **microfone**.
5. Vá para **Escutar** e clique em **Iniciar captura**.
6. Para ouvir texto, vá em **Ler** — o motor **Neural (Edge)** já funciona na
   hora. Se quiser leitura offline, instale o **Piper** em Configurações.

## Empacotando

```bash
npm run make
```

> Observação: o empacotamento **não** embute o whisper.cpp nem o Python — eles são
> baixados sob demanda na primeira execução. Embutir os binários é um passo futuro
> para distribuição totalmente offline.

## Arquitetura

| Camada | Papel |
| --- | --- |
| `src/main.ts` | Processo principal do Electron: janela, permissões, IPC |
| `src/backend/` | Engines (Whisper/Edge/Piper), gerenciador de modelos, Python embutido, settings |
| `src/preload.ts` | Ponte segura `window.sts` (contextIsolation) |
| `src/ui/` | Renderer: abas Escutar/Ler/Configurações, captura + VAD |
| `src/shared/` | Tipos e contrato de IPC compartilhados |

- **STT:** o renderer captura PCM 16 kHz mono, um VAD por energia recorta segmentos
  de fala e os envia ao main via IPC; o `whisper-cli` transcreve cada segmento.
- **TTS Edge:** o main abre um WebSocket com o serviço "Read Aloud" do Edge e
  devolve um MP3. Só o **texto** a ser lido sai da máquina — nunca o áudio do microfone.
- **TTS Piper:** roda num Python embutido (baixado sob demanda), 100% local.

## Privacidade

O processamento de áudio (STT e Piper) é **local**. As saídas de rede são:
o **download de binários/modelos** (GitHub/HuggingFace) sob demanda, e — apenas se
você usar o motor **Edge** de leitura — o **texto** enviado ao serviço da Microsoft.
Para leitura 100% offline, use o **Piper**.

## Licença

MIT
