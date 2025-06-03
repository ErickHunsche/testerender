require("dotenv").config();
const express = require("express");
const venom = require("venom-bot");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors"); // Certifique-se que a importação está correta
const helmet = require("helmet");
const puppeteer = require("puppeteer");
const fs = require('fs');
const path = require('path'); // Módulo 'path' para lidar com caminhos de arquivo

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*", // Se o frontend estiver no mesmo domínio, '*' ou a URL exata
    methods: ["GET", "POST"],
  },
});

// Middlewares de segurança e parsing
app.use(helmet({
    contentSecurityPolicy: { // Ajuste para permitir socket.io e imagens base64 do QR
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "'unsafe-inline'"], // unsafe-inline pode ser necessário para scripts no HTML
        "img-src": ["'self'", "data:"], // Permite imagens 'data:' (para o QR base64)
        "connect-src": ["'self'", (process.env.FRONTEND_URL || "*")], // Permite conexão socket.io
      },
    },
  }));
app.use(express.json());
app.use(cors()); // Habilita CORS para todas as rotas, se necessário para APIs

// --- SERVIR ARQUIVOS ESTÁTICOS E O FRONTEND ---
// Define o diretório 'public' para servir arquivos estáticos (CSS, JS do frontend, imagens etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Rota principal para servir o index.html do frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ---------------------------------------------

const port = process.env.PORT || 3000;
const SESSION_NAME = process.env.SESSION_NAME || "apizap-session";

let venomClient = null;
let connectionStatus = "disconnected";
let isRestarting = false;
let qrCodeData = null;
let qrCodeAttempts = 0;

function emitAndCacheQr(data) {
  qrCodeData = data;
  qrCodeAttempts = data.attempts || 0;
  io.emit("qr", data);
}

async function startVenom() {
  if (isRestarting) {
    console.log("Reinício do Venom já em andamento. Aguardando...");
    return;
  }
  isRestarting = true;
  venomClient = null;
  qrCodeData = null;
  qrCodeAttempts = 0;

  console.log("Iniciando Venom...");
  connectionStatus = "initializing";
  io.emit("status", { /* ... dados do status ... */ });

  try {
    console.log("Tentando obter o caminho do executável do Puppeteer...");
    const puppeteerExecutablePath = await puppeteer.executablePath();
    console.log("Caminho do Chromium (Puppeteer detectou):", puppeteerExecutablePath);

    if (!puppeteerExecutablePath) {
        throw new Error("Puppeteer não conseguiu determinar um caminho para o executável do browser.");
    }
    if (!fs.existsSync(puppeteerExecutablePath)) {
        throw new Error(`Puppeteer retornou o caminho ${puppeteerExecutablePath} mas o arquivo não existe ou não é acessível.`);
    }
    // (Você pode adicionar a verificação de fs.accessSync para executável aqui se desejar)

    console.log(`Usando o diretório de dados do usuário: /tmp/venom-session-${SESSION_NAME}`);

    const client = await venom.create(
      SESSION_NAME,
      (base64Qrimg, asciiQR, attempts, urlCode) => { /* ... seu callback de QR ... */ },
      (statusSession, session) => { /* ... seu callback de status ... */ },
      {
        headless: "new",
        puppeteerOptions: {
          executablePath: puppeteerExecutablePath,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            `--user-data-dir=/tmp/venom-session-${SESSION_NAME}`,
          ],
        },
        logQR: false,
        autoClose: 0,
      }
    );

    venomClient = client;
    console.log("Instância do cliente Venom criada. Monitorando eventos...");

    venomClient.onStateChange((state) => { /* ... seu handler de onStateChange ... */ });
    venomClient.onMessage((message) => { /* ... seu handler de onMessage ... */ });

    console.log("Cliente Venom inicializado. Aguardando autenticação/QR...");
    initializeApiEndpoints(); // Seus endpoints da API /send-message, /status

  } catch (err) {
    console.error("Erro fatal ao iniciar o Venom:", err);
    connectionStatus = "error";
    io.emit("status", { /* ... dados de erro ... */ });
    console.log("Agendando reinício do Venom em 30 segundos devido a erro fatal...");
    setTimeout(() => {
      isRestarting = false;
      startVenom();
    }, 30000);
    return;
  }
  isRestarting = false;
}

// ... (suas funções handleDisconnection, initializeApiEndpoints, io.on('connection')) ...
// Cole suas funções handleDisconnection e initializeApiEndpoints aqui
// Certifique-se de que initializeApiEndpoints define as rotas como /api/send-message ou /api/status
// para não conflitarem com a rota GET / que serve o index.html, ou use um prefixo.

// Exemplo de como poderia ser initializeApiEndpoints para evitar conflito
let apiEndpointsInitialized = false;
function initializeApiEndpoints() {
  if (apiEndpointsInitialized) return;

  const apiRouter = express.Router(); // Usar um router para prefixar

  apiRouter.post("/send-message", async (req, res) => {
    // ... sua lógica de send-message ...
  });

  apiRouter.get("/status", (req, res) => {
    // ... sua lógica de status ...
  });

  app.use('/api', apiRouter); // Monta o router no prefixo /api

  apiEndpointsInitialized = true;
  console.log("Endpoints da API inicializados em /api");
}


// As funções completas de callback de QR e Status, e onStateChange/onMessage para startVenom:
// (Copie e cole suas implementações completas aqui se foram omitidas acima por brevidade)

// Implementação completa de startVenom (exemplo, ajuste com seus callbacks)
async function startVenom_completo() {
  // ... (código de startVenom como antes) ...
  const client = await venom.create(
      SESSION_NAME,
      (base64Qrimg, asciiQR, attempts, urlCode) => {
        console.log(`QR Code gerado (Tentativa: ${attempts})`);
        connectionStatus = "qr";
        const qrDataForEmit = { qr: base64Qrimg, attempts, urlCode };
        emitAndCacheQr(qrDataForEmit);
        io.emit("status", {
          status: "qr",
          message: "Aguardando leitura do QR Code.",
          timestamp: new Date().toISOString(),
          connected: false,
          attempts,
        });
      },
      (statusSession, session) => {
        console.log("Status da Sessão:", statusSession, "| Nome da Sessão:", session);
        let newStatus = connectionStatus;
        let isConnected = (connectionStatus === "connected");

        switch (statusSession) {
          case "isLogged":
          case "qrReadSuccess":
          case "chatsAvailable":
          case "inChat":
            newStatus = "connected";
            isConnected = true;
            qrCodeData = null;
            qrCodeAttempts = 0;
            break;
          case "notLogged": // ... e outros estados de desconexão
            newStatus = "disconnected";
            isConnected = false;
            qrCodeData = null;
            if (!isRestarting && (statusSession !== 'qrReadFail' || connectionStatus !== 'qr')) {
              handleDisconnection(`Status da sessão: ${statusSession}`);
            }
            break;
          case "qrRead": // ... e outros estados de qr
            newStatus = "qr";
            isConnected = false;
            break;
          default:
            newStatus = statusSession;
            break;
        }
        connectionStatus = newStatus;
        io.emit("status", { /* ... dados completos do status ... */ });
      },
      { /* ... opções do venom ... */ }
    );
    // ... (resto do startVenom com onStateChange, onMessage, etc.) ...
}


// --- INICIALIZAÇÃO DO SERVIDOR ---
server.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log(`Acesse o frontend em http://localhost:${port} (se local) ou na URL do seu serviço Render.`);
  startVenom(); // Inicia o bot do WhatsApp
});

// --- GRACEFUL SHUTDOWN ---
async function gracefulShutdown(signal) {
  // ... (sua função gracefulShutdown) ...
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// --- SUAS OUTRAS FUNÇÕES (COLE-AS AQUI) ---
// function handleDisconnection(...) { ... }
// function initializeApiEndpoints() { ... } // Atualizada acima com router
// io.on('connection', (socket) => { ... });