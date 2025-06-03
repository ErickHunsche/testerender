require("dotenv").config();
const express = require("express");
const venom = require("venom-bot");
const http = require("http");
const socketIo = require("socket.io");
const cors = ("cors");
const helmet = require("helmet");
const puppeteer = require("puppeteer"); // Usado para obter o path do browser
const fs = require('fs'); // Para verificar a existência do arquivo

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"],
  },
});

app.use(helmet());
app.use(express.json());
app.use(cors());

const port = process.env.PORT || 3000;
const SESSION_NAME = process.env.SESSION_NAME || "apizap-session";

let venomClient = null;
let connectionStatus = "disconnected"; // disconnected, initializing, qr, connected, error
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
  io.emit("status", {
    status: connectionStatus,
    message: "Iniciando conexão com WhatsApp...",
    timestamp: new Date().toISOString(),
    connected: false,
  });

  try {
    console.log("Tentando obter o caminho do executável do Puppeteer...");
    const puppeteerExecutablePath = await puppeteer.executablePath();
    console.log("Caminho do Chromium (Puppeteer detectou):", puppeteerExecutablePath);

    if (!puppeteerExecutablePath) {
        console.error("CRÍTICO: puppeteer.executablePath() retornou um valor nulo ou indefinido.");
        throw new Error("Puppeteer não conseguiu determinar um caminho para o executável do browser.");
    }

    if (fs.existsSync(puppeteerExecutablePath)) {
        console.log("CONFIRMADO PELO FS: Executável EXISTE em:", puppeteerExecutablePath);
        try {
            fs.accessSync(puppeteerExecutablePath, fs.constants.X_OK);
            console.log("CONFIRMADO PELO FS: Executável do Chromium é EXECUTÁVEL.");
        } catch (accessErr) {
            console.error("ERRO PELO FS: Executável NÃO é EXECUTÁVEL em:", puppeteerExecutablePath, "| Erro:", accessErr.message);
            throw new Error(`Executável em ${puppeteerExecutablePath} não é executável: ${accessErr.message}`);
        }
    } else {
        console.error("CRÍTICO: Executável NÃO FOI ENCONTRADO PELO FS em:", puppeteerExecutablePath);
        throw new Error(`Puppeteer retornou o caminho ${puppeteerExecutablePath} mas o arquivo não existe ou não é acessível.`);
    }

    console.log(`Usando o diretório de dados do usuário: /tmp/venom-session-${SESSION_NAME}`);

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
          case "notLogged":
          case "deviceNotConnected":
          case "desconnectedMobile":
          case "deleteToken":
          case "browserClose":
          case "qrReadFail":
            newStatus = "disconnected";
            isConnected = false;
            qrCodeData = null;
            if (!isRestarting && (statusSession !== 'qrReadFail' || connectionStatus !== 'qr')) {
              console.log(`Status ${statusSession} detectado. Lidando com desconexão.`);
              handleDisconnection(`Status da sessão: ${statusSession}`);
            }
            break;
          case "qrRead":
          case "waitForLogin":
            newStatus = "qr";
            isConnected = false;
            break;
          default:
            newStatus = statusSession;
            break;
        }
        connectionStatus = newStatus;
        io.emit("status", {
          status: connectionStatus,
          originalStatus: statusSession,
          sessionName: session,
          timestamp: new Date().toISOString(),
          connected: isConnected,
        });
      },
      {
        headless: "new",
        puppeteerOptions: {
          executablePath: puppeteerExecutablePath, // USA O CAMINHO DINÂMICO OBTIDO
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            `--user-data-dir=/tmp/venom-session-${SESSION_NAME}`, // Diretório temporário para dados da sessão
          ],
        },
        logQR: false,
        autoClose: 0,
        // debug: true, // Descomente para logs MUITO verbosos do Venom se ainda tiver problemas
      }
    );

    venomClient = client;
    console.log("Instância do cliente Venom criada. Monitorando eventos...");

    venomClient.onStateChange((state) => {
      console.log('Estado geral da sessão alterado:', state);
      const criticalStates = ['CONFLICT', 'UNPAIRED', 'UNLAUNCHED', 'DISCONNECTED'];
      if (criticalStates.includes(state) && !isRestarting) {
        console.log(`Estado crítico da sessão: ${state}. Lidando com desconexão.`);
        handleDisconnection(`Estado crítico: ${state}`);
      }
    });

    venomClient.onMessage((message) => {
      console.log("Mensagem recebida:", message.id?.id || "ID N/A", "| De:", message.from, "| Tipo:", message.type);
      io.emit("message-received", message);
    });

    console.log("Cliente Venom inicializado. Aguardando autenticação/QR...");
    initializeApiEndpoints();

  } catch (err) {
    console.error("Erro fatal ao iniciar o Venom:", err); // ESTE LOG É O QUE VOCÊ ESTAVA VENDO
    connectionStatus = "error";
    io.emit("status", {
      status: "error",
      message: `Erro ao iniciar Venom: ${err.message || err}`, // A mensagem de erro já está aqui
      timestamp: new Date().toISOString(),
      connected: false,
    });
    console.log("Agendando reinício do Venom em 30 segundos devido a erro fatal...");
    setTimeout(() => {
      isRestarting = false;
      startVenom();
    }, 30000);
    return;
  }
  isRestarting = false;
}

function handleDisconnection(reason = "Desconexão solicitada ou detectada") {
  if (isRestarting) {
    console.log(`Já está reiniciando. Motivo da nova chamada para desconexão: ${reason}`);
    return;
  }
  isRestarting = true;
  console.log(`Lidando com desconexão: ${reason}`);
  qrCodeData = null;

  if (venomClient) {
    console.log("Tentando fechar cliente Venom existente...");
    venomClient.close()
      .then(() => console.log("Cliente Venom fechado com sucesso."))
      .catch(err => console.error("Erro ao fechar cliente Venom:", err.message || err))
      .finally(() => {
        venomClient = null;
        connectionStatus = "disconnected";
        io.emit("status", {
          status: "disconnected",
          message: `WhatsApp desconectado. Motivo: ${reason}`,
          timestamp: new Date().toISOString(),
          connected: false,
        });
        console.log("Agendando reinício do Venom em 10 segundos...");
        setTimeout(() => {
          isRestarting = false;
          startVenom();
        }, 10000);
      });
  } else {
    console.log("Nenhum cliente Venom ativo. Agendando início do Venom em 5 segundos...");
    connectionStatus = "disconnected";
    io.emit("status", {
      status: "disconnected",
      message: `WhatsApp desconectado (sem cliente ativo). Motivo: ${reason}`,
      timestamp: new Date().toISOString(),
      connected: false,
    });
    setTimeout(() => {
      isRestarting = false;
      startVenom();
    }, 5000);
  }
}

let apiEndpointsInitialized = false;
function initializeApiEndpoints() {
  if (apiEndpointsInitialized) return;

  app.post("/send-message", async (req, res) => {
    if (!venomClient || connectionStatus !== "connected") {
      return res.status(503).json({ error: "Cliente WhatsApp não está conectado ou pronto." });
    }
    const { to, message } = req.body;
    if (!to || !message) {
      return res.status(400).json({ error: "Os campos 'to' e 'message' são obrigatórios." });
    }
    const recipientId = `${String(to).replace(/\D/g, '')}@c.us`;
    try {
      const result = await venomClient.sendText(recipientId, message);
      console.log("Mensagem enviada para:", recipientId, "ID do resultado:", result.id?.id || 'N/A');
      io.emit("message-sent", { to: recipientId, body: message, result });
      res.json({ status: "Mensagem enviada", id: result.id?.id || null, ack: result.ack });
    } catch (error) {
      console.error("Erro ao enviar mensagem:", error.message || error);
      res.status(500).json({ error: "Erro ao enviar mensagem", details: error.message || error });
    }
  });

  app.get("/status", (req, res) => {
    res.json({
      status: connectionStatus,
      sessionName: SESSION_NAME,
      connected: connectionStatus === "connected" && !!venomClient,
      qrCodeAvailable: connectionStatus === "qr" && !!qrCodeData,
      qrCodeAttempts: qrCodeAttempts,
      timestamp: new Date().toISOString(),
    });
  });
  apiEndpointsInitialized = true;
  console.log("Endpoints da API inicializados.");
}

io.on("connection", (socket) => {
  console.log("Novo Socket.IO cliente conectado:", socket.id);
  socket.emit("status", {
    status: connectionStatus,
    sessionName: SESSION_NAME,
    connected: connectionStatus === "connected" && !!venomClient,
    qrCodeAvailable: connectionStatus === "qr" && !!qrCodeData,
    qrCodeAttempts: qrCodeAttempts,
    timestamp: new Date().toISOString(),
  });
  if (connectionStatus === 'qr' && qrCodeData) {
    socket.emit('qr', qrCodeData);
  }
  socket.on("disconnect", () => {
    console.log("Socket.IO cliente desconectado:", socket.id);
  });
  socket.on("restart-bot", () => {
    console.log("Comando 'restart-bot' recebido do socket:", socket.id);
    handleDisconnection("Solicitação de reinício manual via socket");
  });
  socket.on("get-qr", () => {
    if (connectionStatus === 'qr' && qrCodeData) {
      socket.emit('qr', qrCodeData);
    } else {
      socket.emit('status', { status: connectionStatus, message: "QR não disponível no momento ou já conectado.", connected: connectionStatus === "connected"});
    }
  });
});

server.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log(`Acesse http://localhost:${port} (se local) ou a URL do seu serviço Render.`);
  startVenom();
});

async function gracefulShutdown(signal) {
  console.log(`Sinal ${signal} recebido. Fechando conexões graciosamente...`);
  isRestarting = true;
  if (venomClient) {
    try {
      console.log("Fechando cliente Venom...");
      await venomClient.close();
      console.log('Cliente Venom fechado.');
    } catch (e) {
      console.error("Erro ao fechar cliente Venom:", e.message || e);
    }
  }
  server.close(() => {
    console.log('Servidor HTTP fechado.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Fechamento forçado devido a timeout.");
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));