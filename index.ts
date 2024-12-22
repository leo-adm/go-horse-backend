import express, { Request, Response } from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const PORT = process.env.PORT || 3333;

enum State {
  PAUSED = "PAUSED",
  OPEN_TO_BETS = "OPEN_TO_BETS",
  RACE_STARTING = "RACE_STARTING",
  RACING = "RACING",
  RACE_FINISHED = "RACE_FINISHED",
}

type User = {
  id: string;
  username: string;
  balance: number;
}

type Horse = {
  id: string;
  name: string;
}

type RacingHorse = Horse & {
  odd: number
}

type Bet = {
  userId: string
  horseId: string
  amount: number
}

type HorsePosition = {
  horseId: string
  position: number
}

type Status = {
  user: User
  state: State
  currentRaceHorses?: RacingHorse[]
  currentRacePositions?: HorsePosition[]
}

// Configurações de tempo (em ms)
const BETTING_INTERVAL = 60 * 1000; // 1 minute to bet
const RACE_STARTING_INTERVAL = 5 * 1000 // 5 seconds to start race
const UPDATE_INTERVAL = 1000; // Update positions every second
const INTERVAL_BETWEEN_RACES = 10 * 1000; // 10 seconds between a race finish and a betting interval
const RACE_DISTANCE = 100; // Arbitrary distance

// Dados em memória
const USERS: User[] = [
  {
    id: "1",
    username: "Mitz",
    balance: 1000,
  },
  {
    id: "2",
    username: "Fritz",
    balance: 1000,
  },
]

const ALL_HORSES: Horse[] = [
  { id: "1", name: "Pernambuco" },
  { id: "2", name: "Marquinhos" },
  { id: "3", name: "Jeba" },
  { id: "4", name: "Dinossaura" },
];

// States
let currentState = State.PAUSED;
let currentBets: Bet[];
let currentRaceHorses: RacingHorse[];
let currentRacePositions: HorsePosition[];

let pauseAfterThisRace = false;
let updatePositionsInterval: NodeJS.Timeout | null = null;


// Admin token fake
const ADMIN_TOKEN = "secret123";

const app = express();
app.use(cors());
app.use(express.json());

// Servidor HTTP
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const ioService = {
  emitRaceStateChange: (newState: State) => {
    const data: any = {
      state: newState
    }

    if(newState === State.OPEN_TO_BETS){
      data.currentRaceHorses = currentRaceHorses
    }

    if(newState === State.RACE_STARTING){
      data.currentRacePositions = currentRacePositions
    }

    io.emit("stateChange", data);
  },
  emitPositionsUpdate: (args: any) => {
    io.emit("positionsUpdate", args);
  },
  emitRaceResult: (data: { winnerHorse: RacingHorse}) => {
    io.emit("raceResult", data);
  }
};

function updateState(newState: State){
  console.log(`[STATE UPDATE] New state: ${newState}`)
  currentState = newState;
  ioService.emitRaceStateChange(newState);
}

function getUserById(userId: string): User | undefined {
  return USERS.find((user) => user.id === userId);
}

function getUserFromReq(req: Request): User | undefined {
  const userId = req.headers["x-user-id"] as string || null;

  if(!userId) return undefined;

  return getUserById(userId);
}

function isAdmin(req: Request) {
  return req.headers["x-admin-token"] === ADMIN_TOKEN;
}

// Admin routes
app.post("/admin/start", (req, res): any => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });

  if (currentState !== State.PAUSED) {
    return res
      .status(400)
      .json({ error: "System already running" });
  }

  startBettingPhase();

  res.json({ message: "System started" });
});

app.post("/admin/pause", (req, res): any => {
  if (!isAdmin(req)) return res.status(403).json({ error: "Forbidden" });

  if(pauseAfterThisRace){
    return res.status(400).json({ error: "Pause already scheduled" });
  }

  if(currentState === State.PAUSED){
    return res.status(400).json({ error: "System is already paused" });
  }

  pauseAfterThisRace = true;
});

// User routes
app.post("/bet", (req, res): any => {
  const user = getUserFromReq(req);

  if (!user) {
    return res.status(401).json({ error: "Usuário inválido" });
  }

  if (currentState !== State.OPEN_TO_BETS) {
    return res.status(400).json({ error: "Não é possível apostar agora" });
  }

  const { horseId, amount } = req.body;
  if (horseId === null || horseId === undefined || amount === null || amount == undefined || amount <= 0) {
    return res.status(400).json({ error: "Dados inválidos para aposta" });
  }

  const horse = currentRaceHorses.find(horse => horse.id === horseId)
  if(!horse){
    return res.status(400).json({ error: "Cavalo não faz parte da corrida" });
  }

  if (user.balance < amount) {
    return res.status(400).json({ error: "Saldo insuficiente" });
  }

  user.balance -= amount;
  currentBets.push({ userId: user.id, horseId, amount });
  return res.json({ success: true });
});

app.get("/status", (req, res): any => {
  const user = getUserFromReq(req);

  if (!user) {
    return res.status(401).json({ error: "Usuário inválido" });
  }

  const data: Status = {
    user,
    state: currentState,
  }

  if(currentState !== State.PAUSED){
    data.currentRaceHorses = currentRaceHorses
  }

  if(currentState === State.RACING){
    data.currentRacePositions = currentRacePositions
  }

  res.json(data);
});

app.get("/balance", (req, res): any => {
  const user = getUserFromReq(req);

  if (!user) {
    return res.status(401).json({ error: "Usuário inválido" });
  }

  res.json({ balance: user.balance });
});

// Race control functions
function startBettingPhase() {
  setUpBettingPhase()

  updateState(State.OPEN_TO_BETS);

  setTimeout(() => {
    startRaceStartingPhase();
  }, BETTING_INTERVAL);
}

function setUpBettingPhase() {
  //calculate odds
  const horsesRacing = [...ALL_HORSES]
  currentRaceHorses = horsesRacing.map(horse => {
    return {
      ...horse,
      odd: horsesRacing.length * 0.9
    }
  })

  currentBets = []
}

function startRaceStartingPhase() {
  if(currentBets.length === 0) {
    console.log('[STATE UPDATE] No bets, restarting betting phase...')

    setTimeout(() => {
      startRaceStartingPhase();
    }, BETTING_INTERVAL);

    return;
  }
  
  setUpRaceStartingPhase()

  updateState(State.RACE_STARTING);

  setTimeout(() => {
    startRacingPhase();
  }, RACE_STARTING_INTERVAL)
}

function setUpRaceStartingPhase() {
  currentRacePositions = currentRaceHorses.map((horse) => { 
    return {
      horseId: horse.id, 
      position: 0
    }
  });
}

function startRacingPhase() {
  updateState(State.RACING);

  updatePositionsInterval = setInterval(updateHorsePositions, UPDATE_INTERVAL);
}

function updateHorsePositions() {
  let winnerHorseId: string | null = null;

  for (let i = 0; i < currentRacePositions.length; i++) {
    const advance = Math.floor(Math.random() * 11) + 5;
    currentRacePositions[i].position += advance;
    if (currentRacePositions[i].position >= RACE_DISTANCE && winnerHorseId === null) {
      winnerHorseId = currentRacePositions[i].horseId;
    }
  }

  ioService.emitPositionsUpdate({ currentRacePositions });

  if (winnerHorseId !== null) {
    finishRace(winnerHorseId);
  }
}

function finishRace(winnerHorseId: string) {
  if(currentState == State.RACE_FINISHED) return; // TODO check if this is really necessary

  updateState(State.RACE_FINISHED)
  if (updatePositionsInterval) clearInterval(updatePositionsInterval);

  const winnerHorse: RacingHorse = currentRaceHorses.find(horse => horse.id === winnerHorseId)!;

  const winnerBets = currentBets.filter(bet => bet.horseId === winnerHorse.id);

  winnerBets.forEach(bet => {
    const user = getUserById(bet.userId)!;
    user.balance += bet.amount * winnerHorse.odd;
  })

  ioService.emitRaceResult({ winnerHorse })

  setTimeout(() => {
    if(pauseAfterThisRace) {
      updateState(State.PAUSED);
      pauseAfterThisRace = false;
      return;
    }
    
    startBettingPhase();
  }, INTERVAL_BETWEEN_RACES);
}

// io.on("connection", (socket) => {
//   socket.emit("stateChange", { state: currentState });
// });

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
