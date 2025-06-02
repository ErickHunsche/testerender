require("dotenv").config();
const express = require("express");
const venom = require("venom-bot");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const puppeteer = require("puppeteer"); // Usado para obter o path do browser

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
let qrCodeData = null; // Armazena { qr, attempts, urlCode }
let qrCodeAttempts = 0;

// Função para emitir e cachear o QR Code
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
  venomClient = null; // Garante que o cliente antigo seja limpo
  qrCodeData = null; // Limpa QR cache
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
    const puppeteerExecutablePath = await puppeteer.executablePath();
    console.log("Caminho do Chromium (Puppeteer):", puppeteerExecutablePath);

    // DEFINIR A VARIÁVEL DE AMBIENTE ANTES DE CHAMAR VENOM.CREATE
    // Isso pode ajudar o Venom a encontrar o browser correto.
    process.env.PUPPETEER_EXECUTABLE_PATH = puppeteerExecutablePath;

    console.log(`Usando o diretório de dados do usuário: /tmp/venom-session-${SESSION_NAME}`);

    const client = await venom.create(
      // 1. Nome da Sessão
      SESSION_NAME,
      // 2. Callback do QR Code
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
      // 3. Callback de Status
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
            qrCodeData = null; // Limpar QR após conexão
            qrCodeAttempts = 0;
            break;
          case "notLogged":
          case "deviceNotConnected":
          case "desconnectedMobile": // Venom pode usar este
          case "deleteToken":
          case "browserClose": // Pode ser um problema ou um fechamento normal
          case "qrReadFail":
            newStatus = "disconnected";
            isConnected = false;
            qrCodeData = null;
            // Evitar loop se já estiver reiniciando ou se for um QR falho e o bot ainda estiver na fase de QR.
            if (!isRestarting && (statusSession !== 'qrReadFail' || connectionStatus !== 'qr')) {
              console.log(`Status ${statusSession} detectado. Lidando com desconexão.`);
              handleDisconnection(`Status da sessão: ${statusSession}`);
            }
            break;
          case "qrRead": // Quando o QR está sendo exibido/processado
          case "waitForLogin": // Aguardando o login após o QR (ou se já logado e reiniciando)
            newStatus = "qr";
            isConnected = false;
            // O QR é emitido pelo callback `qrcode`
            break;
          default:
            newStatus = statusSession; // Manter o status original se não mapeado
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
      // 4. Opções de Configuração
      {
        headless: "new", // Modo headless recomendado
        puppeteerOptions: {
          executablePath: puppeteerExecutablePath, // Fornece o caminho explicitamente
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Crucial para ambientes como Docker/Render
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu', // Pode ajudar em ambientes sem GPU
            `--user-data-dir=/tmp/venom-session-${SESSION_NAME}`, // Diretório de dados do usuário gravável
            // '--single-process', // Descomente apenas como último recurso, pode afetar estabilidade
          ],
        },
        // NÃO use useChrome: false ou browserPath aqui se puppeteerOptions está setado.
        logQR: false, // Já estamos tratando o QR
        autoClose: 0, // Mantém a sessão ativa (em ms, 0 para desabilitar)
        // debug: true, // Ative para logs muito detalhados do Venom, pode ajudar a diagnosticar
      }
    );

    venomClient = client;
    console.log("Instância do cliente Venom criada. Monitorando eventos...");

    // Monitora mudanças de estado mais amplas
    venomClient.onStateChange((state) => {
      console.log('Estado geral da sessão alterado:', state);
      const criticalStates = ['CONFLICT', 'UNPAIRED', 'UNLAUNCHED', 'DISCONNECTED'];
      if (criticalStates.includes(state) && !isRestarting) {
        console.log(`Estado crítico da sessão: ${state}. Lidando com desconexão.`);
        handleDisconnection(`Estado crítico: ${state}`);
      }
    });

    // Handler para mensagens recebidas
    venomClient.onMessage((message) => {
      console.log("Mensagem recebida:", message.id?.id || "ID N/A", "| De:", message.from, "| Tipo:", message.type);
      io.emit("message-received", message);
    });

    // Se chegou aqui, a instância foi criada, mas ainda pode não estar autenticada.
    // O status "connected" será definido pelo callback de status.
    console.log("Cliente Venom inicializado. Aguardando autenticação/QR...");
    initializeApiEndpoints(); // Garante que os endpoints da API estejam prontos

  } catch (err) {
    console.error("Erro fatal ao iniciar o Venom:", err);
    connectionStatus = "error";
    io.emit("status", {
      status: "error",
      message: `Erro ao iniciar Venom: ${err.message || err}`,
      timestamp: new Date().toISOString(),
      connected: false,
    });
    // Tenta reiniciar após um tempo
    console.log("Agendando reinício do Venom em 30 segundos devido a erro fatal...");
    setTimeout(() => {
      isRestarting = false; // Permite nova tentativa
      startVenom();
    }, 30000); // Delay de 30 segundos
    return; // Sai da função para não setar isRestarting para false imediatamente abaixo
  }
  isRestarting = false; // Reseta a flag de reinício apenas se a tentativa foi bem-sucedida (ou falhou e foi tratada acima)
}

function handleDisconnection(reason = "Desconexão solicitada ou detectada") {
  if (isRestarting) {
    console.log(`Já está reiniciando. Motivo da nova chamada para desconexão: ${reason}`);
    return;
  }
  isRestarting = true; // Marca que um processo de reinício começou
  console.log(`Lidando com desconexão: ${reason}`);
  qrCodeData = null; // Limpa QR cache

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
          isRestarting = false; // Permite que startVenom seja chamado
          startVenom();
        }, 10000); // Delay para evitar loops rápidos
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
      isRestarting = false; // Permite que startVenom seja chamado
      startVenom();
    }, 5000);
  }
}

// Função para inicializar os endpoints da API
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

    const recipientId = `${String(to).replace(/\D/g, '')}@c.us`; // Limpa e formata o número

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

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log("Novo Socket.IO cliente conectado:", socket.id);

  // Envia o status atual e o QR (se houver) para o novo cliente
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

// Inicia o servidor e o bot
server.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log(`Acesse http://localhost:${port} (se local) ou a URL do seu serviço Render.`);
  startVenom(); // Inicia o processo do Venom
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`Sinal ${signal} recebido. Fechando conexões graciosamente...`);
  isRestarting = true; // Previne tentativas de reinício durante o shutdown

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
    process.exit(0); // Saída limpa
  });

  // Força a saída após um timeout se o fechamento não completar
  setTimeout(() => {
    console.error("Fechamento forçado devido a timeout. Algo impediu o fechamento gracioso.");
    process.exit(1); // Saída com erro
  }, 10000); // Timeout de 10 segundos
}

process.on('SIGINT', () => gracefulShutdown('SIGINT')); // Ctrl+C
process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Sinal de término do Render/Docker