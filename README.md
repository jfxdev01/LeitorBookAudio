# LeitorBook Áudio

Aplicativo desktop (Windows) para **ler e ouvir livros em PDF**. Tem uma biblioteca para cadastrar os livros e, ao abrir um deles, você pode ler normalmente ou clicar em **Ouvir**: a frase que está sendo falada fica destacada no PDF (e também a palavra atual). Dá para escolher o idioma e a voz e, se o idioma escolhido for diferente do idioma do texto, o app **traduz cada frase em tempo real** e lê a tradução.

## Como executar

Requisitos: Node.js 18 ou mais recente.

```bash
npm install
npm start
```

Para gerar o instalador do Windows (`dist/LeitorBook Áudio Setup x.y.z.exe`):

```bash
npm run dist            # instalador NSIS
npm run dist:portable   # executável portátil, sem instalação
```

## Funcionalidades

### Biblioteca
- Cadastro de PDFs pelo botão **Adicionar livros**, arrastando os arquivos para a janela ou pelo "Abrir com…" do Windows. Os arquivos são copiados para a pasta de dados do app, e PDFs duplicados são detectados.
- Capa gerada a partir da primeira página; título, autor e idioma lidos dos metadados e detectados pelo texto.
- Busca por título/autor, filtros (lendo, não iniciados, concluídos, favoritos), ordenação e favoritos.
- Cartão **Continuar de onde parou**, com progresso, e atalho para **Continuar ouvindo** a partir da última frase.
- Editar informações, ver estatísticas (tempo lendo, tempo ouvindo, marcadores) e remover livros.

### Leitura
- Rolagem contínua, zoom (ajustar à largura, página inteira, Ctrl + roda do mouse), navegação por página.
- Sumário do PDF, **marcadores com anotações** e **busca no livro inteiro** (ignora acentos e maiúsculas).
- Cor da página: normal, sépia ou noturna. Tema claro/escuro do app.
- Lembra a página, o zoom e a posição da narração de cada livro.

### Narração (Ouvir)
- Destaque da **frase** em leitura e da **palavra** falada, com rolagem automática acompanhando a leitura.
- **Clique em qualquer frase** durante a narração para continuar dali, ou use o botão direito → *Ouvir a partir daqui*.
- Dois tipos de voz:
  - **Neurais online** (Microsoft Edge): mais de 300 vozes naturais em dezenas de idiomas. Precisam de internet.
  - **Do Windows**: funcionam offline. São as vozes instaladas no sistema (em *Configurações › Hora e idioma › Fala* é possível instalar mais). Se não houver voz do Windows para o idioma, o app usa as vozes neurais e avisa.
- Velocidade (0,5x a 3x), tom e volume. Botão para testar a voz.
- **Legenda** opcional com a frase atual e a palavra destacada.
- **Timer de sono**: parar após X minutos, no fim da página ou no fim do capítulo.
- Teclas de mídia do teclado (play/pause, próxima, anterior) enquanto a narração está ativa.

### Tradução simultânea
- Em **Voz e idioma › Ouvir em**, escolha um idioma diferente do texto: cada frase é traduzida antes de ser lida, e as próximas são traduzidas antecipadamente para não haver pausas.
- A frase original continua destacada no PDF, e a legenda mostra o original e a tradução.
- Serviços: Google Tradutor (padrão, sem cadastro), DeepL (com chave de API) ou LibreTranslate (servidor próprio). As traduções ficam em cache.
- Botão direito sobre um trecho selecionado → **Traduzir** ou **Ouvir** só aquele trecho.

### Gerar audiolivro (MP3)
- Converte um intervalo de páginas (ou o capítulo atual) em um arquivo MP3 com a voz neural escolhida, já traduzido se a tradução estiver ativa.

## Atalhos

| Tecla | Ação |
|---|---|
| Espaço | Ouvir / pausar |
| Ctrl + → / Ctrl + ← | Próxima / anterior frase |
| Page Down / Page Up, → / ← | Próxima / anterior página |
| Ctrl + F | Buscar no livro |
| Ctrl + B | Marcar a página |
| Ctrl + + / − / 0 | Zoom |
| S | Mostrar/ocultar legenda |
| V | Painel de voz e idioma |
| F11 | Tela cheia |
| ? | Lista de atalhos |

## Privacidade
- As vozes do Windows e a leitura funcionam totalmente offline.
- Com as **vozes neurais online**, o texto de cada frase é enviado ao serviço de voz da Microsoft. Com a **tradução**, ao serviço de tradução escolhido.
- Biblioteca, capas, progresso e cache de tradução ficam em `%APPDATA%\leitorbookaudio`.

## Limitações
- PDFs digitalizados (só imagens, sem texto selecionável) podem ser lidos visualmente, mas não narrados, porque o app não faz OCR.
- Em layouts muito complexos (várias colunas, tabelas), a ordem das frases segue a ordem do texto dentro do PDF.

## Estrutura

```
src/main/        processo principal: janela, biblioteca, voz neural, tradução
src/preload.js   ponte segura entre a interface e o processo principal
src/renderer/    interface (HTML/CSS/JS)
  js/pdf-doc.js      extração do texto e divisão em frases (com mapa para o destaque)
  js/pdf-viewer.js   visualizador com camadas de texto e destaque
  js/narrator.js     narração frase a frase, tradução antecipada
  js/tts.js          motores de voz (Windows e neurais online)
  js/reader-view.js  tela de leitura
  js/library-view.js tela da biblioteca
scripts/         PDFs de exemplo, ícone e testes automatizados (Playwright)
```

## Testes

```bash
npm test          # gera PDFs de exemplo e roda os testes de ponta a ponta
npm run test:layout
```

Os testes abrem o app de verdade, cadastram PDFs e verificam narração, destaque, tradução, busca, marcadores, timer, temas e geração de MP3. As capturas de tela ficam em `test-output/`.
