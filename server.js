require("dotenv").config()
const express = require("express")
const venom = require("venom-bot")
const http = require("http")
const socketIo = require("socket.io")
const cors = require("cors")
const helmet = require("helmet")

const app = express()
const server = http.createServer(app)
const io = socketIo(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*", // ou limitar se necessário
    methods: ["GET", "POST"],
  },
})

app.use(helmet())
app.use(express.json())
app.use(cors())

const port = process.env.PORT || 3000

let venomClient
let connectionStatus = "disconnected"

venom
  .create({
    session: "apizap",
    headless: true, // HEADLESS ativado em produção!
    logQR: false,
    statusFind: (statusSession, session) => {
      console.log("Status Session:", statusSession)

      io.emit("status", {
        status: statusSession,
        session: session,
        timestamp: new Date().toISOString(),
        connected: statusSession === "connected",
      })

      connectionStatus = statusSession
    },
    qrCallback: (base64Qr, asciiQR, attempts, urlCode) => {
      console.log("QR Code tentativa:", attempts)

      io.emit("qr", {
        qr: base64Qr,
        attempts: attempts,
        urlCode: urlCode,
      })
    },
  })
  .then((client) => {
    venomClient = client
    connectionStatus = "connected"

    console.log("Cliente Venom conectado!")

    io.emit("status", {
      status: "connected",
      message: "WhatsApp conectado!",
      timestamp: new Date().toISOString(),
      connected: true,
    })

    client.onMessage((message) => {
      console.log("Mensagem recebida:", message)
      io.emit("message-received", message)
    })

    start(client)
  })
  .catch((erro) => {
    console.error("Erro Venom:", erro)
    connectionStatus = "error"

    io.emit("status", {
      status: "error",
      message: erro.message,
      timestamp: new Date().toISOString(),
      connected: false,
    })
  })

const start = (client) => {
  app.post("/send-message", async (req, res) => {
    if (!client) {
      return res.status(503).json({ error: "Cliente WhatsApp não pronto." })
    }

    const { to, message } = req.body
    if (!to || !message) {
      return res.status(400).json({ error: "Campos 'to' e 'message' obrigatórios." })
    }

    const recipientId = `${to}@c.us`
    try {
      const result = await client.sendText(recipientId, message)
      io.emit("message-sent", { to: recipientId, message, result })
      res.json({ status: "Mensagem enviada", result })
    } catch (error) {
      console.error("Erro envio:", error)
      res.status(500).json({ error: "Erro ao enviar", details: error.message })
    }
  })

  app.get("/status", (req, res) => {
    res.json({
      status: connectionStatus,
      connected: !!venomClient,
      timestamp: new Date().toISOString(),
    })
  })
}

io.on("connection", (socket) => {
  console.log("Socket conectado")

  socket.emit("status", {
    status: connectionStatus,
    connected: !!venomClient,
    timestamp: new Date().toISOString(),
  })

  socket.on("disconnect", () => {
    console.log("Socket desconectado")
  })

  socket.on("restart-bot", () => {
    console.log("Reiniciando bot...")
    if (venomClient) {
      venomClient.close()
    }
  })
})

server.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`)
})
