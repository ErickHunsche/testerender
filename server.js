require("dotenv").config();
const express = require("express");
const venom = require("venom-bot");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const puppeteer = require("puppeteer");

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

let venomClient = null;
let connectionStatus = "disconnected"; // disconnected, initializing, qr, connected, error
let isRestarting = false;
let qrCodeAttempts = 0;

// Cache do QR Code para novos clientes socket
io.qr_cache = null;
const originalEmit = io.emit;
io.emit = function(event, ...args) {
    if (event === 'qr') {
        io.qr_cache = args[0]; // Armazena o payload do QR (o objeto { qr, attempts, urlCode })
        qrCodeAttempts = args[0].attempts || 0;
    }
    // Garante que a emissão original ocorra
    return originalEmit.apply(this, [event, ...args]);
};


async function startVenom() {
  if (isRestarting) {
    console.log("Reinício já em progresso. Aguardando...");
    return;
  }
  isRestarting = true;
  venomClient = null; // Garante que o cliente antigo seja limpo antes de tentar criar um novo

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
    console.log("Caminho do Chromium encontrado:", puppeteerExecutablePath);

    // Limpar cache do QR antes de tentar uma nova conexão
    io.qr_cache = null;
    qrCodeAttempts = 0;

    const client = await venom.create({
      session: process.env.SESSION_NAME || "apizap",
      headless: "new",
      puppeteerOptions: {
        executablePath: puppeteerExecutablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          // '--single-process', // Descomente apenas se outros métodos falharem e você souber as implicações
        ],
      },
      logQR: false, // O QR é enviado via socket
      autoClose: 0,
      statusFind: (statusSession, session) => {
        console.log("Status Session:", statusSession, "| Session:", session);
        let currentStatus = statusSession;
        let connected = false;

        if (statusSession === "isLogged" || statusSession === "qrReadSuccess" || statusSession === "chatsAvailable" || statusSession === "inChat" || statusSession === "browserClose") {
            // 'browserClose' pode indicar que o usuário fechou a sessão no telefone
            // ou que o Puppeteer foi fechado inesperadamente.
            // Se for 'isLogged', 'qrReadSuccess', 'chatsAvailable', 'inChat', estamos bem.
            if (["isLogged", "qrReadSuccess", "chatsAvailable", "inChat"].includes(statusSession)) {
                currentStatus = "connected";
                connected = true;
                io.qr_cache = null; // Limpar QR cache após conexão bem-sucedida
                qrCodeAttempts = 0;
            } else {
                // Para 'browserClose' ou outros estados não explicitamente conectados
                currentStatus = "disconnected";
            }
        } else if (statusSession === "notLogged" || statusSession === "deviceNotConnected" || statusSession === "desconnectedMobile" || statusSession === "deleteToken") {
            currentStatus = "disconnected";
            io.qr_cache = null; // Limpar QR
        } else if (statusSession === "qrRead" || statusSession === "waitForLogin"){
            currentStatus = "qr";
            // O QR é emitido pelo callback `qrcode`
        } else {
            currentStatus = statusSession; // Manter o status original se não mapeado
        }
        
        connectionStatus = currentStatus;

        io.emit("status", {
          status: connectionStatus,
          originalStatus: statusSession,
          session: session,
          timestamp: new Date().toISOString(),
          connected: connected,
        });

        if (statusSession === 'notLogged' || statusSession === 'deviceNotConnected' || statusSession === 'desconnectedMobile' || statusSession === 'browserClose' || statusSession === 'deleteToken') {
          console.log(`Sessão ${statusSession}. Tentando reconectar...`);
          handleDisconnection("Sessão " + statusSession);
        }
      },
      qrcode: (base64Qrimg, asciiQR, attempts, urlCode) => {
        console.log("QR Code gerado, tentativa:", attempts, "URL Code:", urlCode);
        connectionStatus = "qr";
        qrCodeAttempts = attempts;
        io.emit("qr", { // io.emit já faz o cache através do wrapper
          qr: base64Qrimg,
          attempts: attempts,
          urlCode: urlCode,
        });
        io.emit("status", {
          status: "qr",
          message: "Aguardando leitura do QR Code.",
          timestamp: new Date().toISOString(),
          connected: false,
          attempts: attempts
        });
      },
    });

    venomClient = client; // Atribui o cliente à variável global
    console.log("Instância do cliente Venom criada. Monitorando eventos...");

    venomClient.onStateChange((state) => {
        console.log('Estado da sessão alterado: ', state);
        const criticalStates = ['CONFLICT', 'UNPAIRED', 'UNLAUNCHED', 'DISCONNECTED'];
        if (criticalStates.includes(state)) {
            console.log(`Estado crítico da sessão: ${state}. Tentando fechar e reiniciar.`);
            handleDisconnection(`Estado crítico: ${state}`);
        }
    });

    venomClient.onMessage((message) => {
      console.log("Mensagem recebida:", message.id ? message.id.id : "ID N/A", "| De:", message.from, "| Tipo:", message.type);
      io.emit("message-received", message);
    });

    // Após a criação bem-sucedida da instância, mas ANTES da autenticação completa
    // O status "connected" será definido pelo statusFind
    console.log("Cliente Venom inicializado. Aguardando autenticação...");
    startEndpoints(venomClient);

  } catch (err) {
    console.error("Erro fatal ao iniciar Venom:", err);
    connectionStatus = "error";
    io.emit("status", {
      status: "error",
      message: `Erro ao iniciar Venom: ${err.message}`,
      timestamp: new Date().toISOString(),
      connected: false,
    });
    // Tentar reiniciar após um tempo maior em caso de erro grave
    console.log("Agendando reinício do Venom em 30 segundos devido a erro fatal...");
    setTimeout(() => {
        isRestarting = false;
        startVenom();
    }, 30000); // Delay de 30 segundos
    return; // Sai da função para não setar isRestarting para false imediatamente
  }
  isRestarting = false; // Permitir novo reinício se necessário APÓS tentativa bem sucedida ou falha tratada
}

function handleDisconnection(reason = "Desconexão solicitada ou detectada") {
    if (isRestarting) {
        console.log(`Já está reiniciando. Motivo da nova chamada: ${reason}`);
        return;
    }
    isRestarting = true;
    console.log(`Lidando com desconexão: ${reason}`);

    if (venomClient) {
        console.log("Tentando fechar cliente Venom existente...");
        venomClient.close()
            .then(() => console.log("Cliente Venom fechado com sucesso."))
            .catch(err => console.error("Erro ao fechar cliente Venom:", err.message))
            .finally(() => {
                venomClient = null;
                connectionStatus = "disconnected";
                io.emit("status", {
                    status: "disconnected",
                    message: "WhatsApp desconectado.",
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
        console.log("Nenhum cliente ativo. Agendando início do Venom em 5 segundos...");
        connectionStatus = "disconnected";
        io.emit("status", {
            status: "disconnected",
            message: "WhatsApp desconectado, tentando reconectar...",
            timestamp: new Date().toISOString(),
            connected: false,
        });
        setTimeout(() => {
            isRestarting = false;
            startVenom();
        }, 5000);
    }
}

startVenom();

const startEndpoints = (clientInstance) => { // Recebe a instância do cliente
  // Usar clientInstance em vez de venomClient global aqui para garantir que estamos usando a instância correta
  // que acabou de ser criada, embora venomClient global também seja atualizado.

  if (!app.route_handlers_attached) { // Evitar adicionar rotas múltiplas vezes
    app.post("/send-message", async (req, res) => {
      if (!venomClient || connectionStatus !== "connected") {
        return res.status(503).json({ error: "Cliente WhatsApp não conectado ou não pronto." });
      }

      const { to, message } = req.body;
      if (!to || !message) {
        return res.status(400).json({ error: "Campos 'to' e 'message' são obrigatórios." });
      }

      const recipientId = `${String(to).replace(/\D/g, '')}@c.us`;

      try {
        const result = await venomClient.sendText(recipientId, message);
        console.log("Mensagem enviada para:", recipientId, "Resultado ID:", result.id ? result.id.id : 'N/A');
        io.emit("message-sent", { to: recipientId, body: message, result });
        res.json({ status: "Mensagem enviada", id: result.id ? result.id.id : null, ack: result.ack });
      } catch (error) {
        console.error("Erro ao enviar mensagem:", error.message);
        res.status(500).json({ error: "Erro ao enviar mensagem", details: error.message });
      }
    });

    app.get("/status", (req, res) => {
      res.json({
        status: connectionStatus,
        sessionName: venomClient && venomClient.session ? venomClient.session : (process.env.SESSION_NAME || "apizap"),
        connected: connectionStatus === "connected" && !!venomClient,
        qrCodeAvailable: connectionStatus === "qr" && !!io.qr_cache,
        qrCodeAttempts: qrCodeAttempts,
        timestamp: new Date().toISOString(),
      });
    });
    app.route_handlers_attached = true;
  }
};

io.on("connection", (socket) => {
  console.log("Novo Socket conectado:", socket.id);

  socket.emit("status", {
    status: connectionStatus,
    sessionName: venomClient && venomClient.session ? venomClient.session : (process.env.SESSION_NAME || "apizap"),
    connected: connectionStatus === "connected" && !!venomClient,
    qrCodeAvailable: connectionStatus === "qr" && !!io.qr_cache,
    qrCodeAttempts: qrCodeAttempts,
    timestamp: new Date().toISOString(),
  });

  if (connectionStatus === 'qr' && io.qr_cache) {
    socket.emit('qr', io.qr_cache);
  }

  socket.on("disconnect", () => {
    console.log("Socket desconectado:", socket.id);
  });

  socket.on("restart-bot", () => {
    console.log("Comando 'restart-bot' recebido do socket:", socket.id);
    handleDisconnection("Solicitação de reinício manual via socket");
  });

  socket.on("get-qr", () => {
    if (connectionStatus === 'qr' && io.qr_cache) {
        socket.emit('qr', io.qr_cache);
    } else {
        // Se não houver QR ativo, mas o bot não estiver conectado, pode ser útil reiniciar
        // para forçar um novo QR, se essa for a intenção.
        // Ou apenas informar que não há QR no momento.
        socket.emit('status', { status: connectionStatus, message: "QR não disponível no momento ou já conectado."});
        // if (connectionStatus !== 'connected') {
        //    handleDisconnection("Solicitação de QR e não conectado");
        // }
    }
  });
});

server.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
  console.log(`Acesse http://localhost:${port} para interagir se estiver localmente.`);
});

async function gracefulShutdown(signal) {
  console.log(`Recebido ${signal}. Fechando conexões...`);
  isRestarting = true; // Prevenir tentativas de reinício durante o shutdown
  if (venomClient) {
    try {
      console.log("Fechando cliente Venom...");
      await venomClient.close();
      console.log('Cliente Venom fechado.');
    } catch (e) {
      console.error("Erro ao fechar cliente Venom:", e.message);
    }
  }
  server.close(() => {
    console.log('Servidor HTTP fechado.');
    process.exit(0);
  });
  // Forçar saída após timeout se o close não completar
  setTimeout(() => {
    console.error("Fechamento forçado após timeout.");
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));