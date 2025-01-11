import express, { NextFunction, Request, Response } from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import {
  clerkMiddleware,
  ExpressRequestWithAuth,
  requireAuth,
} from "@clerk/express";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  Bet,
  Horse,
  HorsePosition,
  RacingHorse,
  State,
  Status,
  CustomJwtSessionClaims,
} from "./types/types";
import { users } from "./db/schema";
import { eq, sql } from "drizzle-orm";
import bodyParser from "body-parser";
import { Webhook } from "svix";

const db = drizzle(process.env.DATABASE_URL!);

const PORT = process.env.PORT || 3333;

// Configurações de tempo (em ms)
const BETTING_INTERVAL = 60 * 1000; // 1 minute to bet
const RACE_STARTING_INTERVAL = 5 * 1000; // 5 seconds to start race
const UPDATE_INTERVAL = 1000; // Update positions every second
const INTERVAL_BETWEEN_RACES = 10 * 1000; // 10 seconds between a race finish and a betting interval
const RACE_DISTANCE = 100; // Arbitrary distance

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

const app = express();
app.use(cors());
app.use(clerkMiddleware());

app.post(
  "/webhooks",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const SIGNING_SECRET = process.env.SIGNING_SECRET

    if (!SIGNING_SECRET) {
      throw new Error(
        "Error: Please add SIGNING_SECRET from Clerk Dashboard to .env"
      )
    }

    // Create new Svix instance with secret
    const wh = new Webhook(SIGNING_SECRET)

    // Get headers and body
    const headers = req.headers
    const payload = req.body

    // Get Svix headers for verification
    const svix_id = headers["svix-id"]
    const svix_timestamp = headers["svix-timestamp"]
    const svix_signature = headers["svix-signature"]

    // If there are no headers, error out
    if (!svix_id || !svix_timestamp || !svix_signature) {
      return void res.status(400).json({
        success: false,
        message: "Error: Missing svix headers",
      })
    }

    let evt: any

    // Attempt to verify the incoming webhook
    // If successful, the payload will be available from 'evt'
    // If verification fails, error out and return error code
    try {
      evt = wh.verify(payload, {
        "svix-id": svix_id as string,
        "svix-timestamp": svix_timestamp as string,
        "svix-signature": svix_signature as string,
      })
    } catch (err: any) {
      console.log("Error: Could not verify webhook:", err.message)
      return void res.status(400).json({
        success: false,
        message: err.message,
      })
    }

    const eventType = evt.type
    if (eventType === "user.created") {
      const userId = evt.data.id

      try {
        await db.insert(users).values({
          id: userId,
          balance: "0",
        })
      } catch (err: any) {
        console.log("Error: Could not create user:", err.message)
        return void res.status(400).json({
          success: false,
          message: err.message,
        })
      }
    } else {
      console.log("Error: Unknown event type:", eventType)
      return void res.status(400).json({
        success: false,
        message: "Unknown event type",
      })
    }

    return void res.status(200).json({
      success: true,
      message: "Webhook received",
    })
  }
)

app.use(express.json());

// Servidor HTTP
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const ioService = {
  emitRaceStateChange: (newState: State) => {
    const data: any = {
      state: newState,
    };

    if (newState === State.OPEN_TO_BETS) {
      data.currentRaceHorses = currentRaceHorses;
    }

    if (newState === State.RACE_STARTING) {
      data.currentRacePositions = currentRacePositions;
    }

    io.emit("stateChange", data);
  },
  emitPositionsUpdate: (args: any) => {
    io.emit("positionsUpdate", args);
  },
  emitRaceResult: (data: { winnerHorse: RacingHorse }) => {
    io.emit("raceResult", data);
  },
};

function updateState(newState: State) {
  console.log(`[STATE UPDATE] New state: ${newState}`);
  currentState = newState;
  ioService.emitRaceStateChange(newState);
}

function isAdmin(sessionClaims: CustomJwtSessionClaims): boolean {
  return sessionClaims.metadata.role === "admin";
}

// Admin routes
function adminOnly(req: Request, res: Response, next: NextFunction): any {
  const { sessionClaims } = (req as ExpressRequestWithAuth).auth;

  if (isAdmin(sessionClaims as CustomJwtSessionClaims)) return next();

  return res.status(403).send();
}

app.post("/admin/start", requireAuth(), adminOnly, (req, res): any => {
  if (currentState !== State.PAUSED) {
    return res.status(400).json({ error: "System already running" });
  }

  startBettingPhase();

  res.json({ message: "System started" });
});

app.post("/admin/pause", requireAuth(), adminOnly, (req, res): any => {
  switch(currentState){
    case State.OPEN_TO_BETS:
      if(currentBets.length === 0){ // if no bets, immediately pause
        updateState(State.PAUSED);
        return res.status(200).json({ message: "System paused" })
      }
    case State.RACE_STARTING:
    case State.RACING:
    case State.RACE_FINISHED:
      pauseAfterThisRace = true;
      return res.status(200).json({ message: "System will be paused after the current race" })
    case State.PAUSED:
      return res.status(200).json({ message: "System is already paused" });
  }
});

// User routes
app.post("/bet", requireAuth(), async (req, res): Promise<any> => {
  const { userId } = (req as ExpressRequestWithAuth).auth;

  if (!userId) return res.status(401).json({ error: "Invalid user" });

  const [user] = await db.select().from(users).where(eq(users.id, userId));

  if (currentState !== State.OPEN_TO_BETS) {
    return res.status(400).json({ error: "Unable to bet right now" });
  }

  const { horseId, amount } = req.body;
  if (
    horseId === null ||
    horseId === undefined ||
    amount === null ||
    amount == undefined ||
    amount <= 0
  ) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const horse = currentRaceHorses.find((horse) => horse.id === horseId);
  if (!horse) {
    return res.status(400).json({ error: "Horse not in the race" });
  }

  if (user.balance < amount) {
    return res.status(400).json({ error: "Insuficient balance" });
  }

  const newBalance = Number(user.balance) - amount;
  await db
    .update(users)
    .set({ balance: newBalance.toString() })
    .where(eq(users.id, user.id));
  currentBets.push({ userId: user.id, horseId, amount });
  return res.json({ success: true });
});

app.get("/status", (req, res): any => {
  const data: Status = {
    state: currentState,
  };

  if (currentState !== State.PAUSED) {
    data.currentRaceHorses = currentRaceHorses;
  }

  if (currentState === State.RACING) {
    data.currentRacePositions = currentRacePositions;
  }

  res.json(data);
});

app.get("/balance", requireAuth(), async (req, res): Promise<any> => {
  const { userId } = (req as ExpressRequestWithAuth).auth;

  if (!userId) return res.status(401).json({ error: "Invalid user" });

  const resUsers = await db.select().from(users).where(eq(users.id, userId));

  if (resUsers.length === 0) {
    res.json({ balance: 0 });
  }

  res.json({ balance: resUsers[0].balance });
});

// Race control functions
async function startBettingPhase() {
  setUpBettingPhase();

  updateState(State.OPEN_TO_BETS);

  setTimeout(() => {
    startRaceStartingPhase();
  }, BETTING_INTERVAL);
}

function setUpBettingPhase() {
  //calculate odds
  const horsesRacing = [...ALL_HORSES];
  currentRaceHorses = horsesRacing.map((horse) => {
    return {
      ...horse,
      odd: horsesRacing.length * 0.9,
    };
  });

  currentBets = [];
}

function startRaceStartingPhase() {
  if (currentBets.length === 0) {
    console.log("[STATE UPDATE] No bets, restarting betting phase...");

    setTimeout(() => {
      startRaceStartingPhase();
    }, BETTING_INTERVAL);

    return;
  }

  setUpRaceStartingPhase();

  updateState(State.RACE_STARTING);

  setTimeout(() => {
    startRacingPhase();
  }, RACE_STARTING_INTERVAL);
}

function setUpRaceStartingPhase() {
  currentRacePositions = currentRaceHorses.map((horse) => {
    return {
      horseId: horse.id,
      position: 0,
    };
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
    if (
      currentRacePositions[i].position >= RACE_DISTANCE &&
      winnerHorseId === null
    ) {
      winnerHorseId = currentRacePositions[i].horseId;
    }
  }

  ioService.emitPositionsUpdate({ currentRacePositions });

  if (winnerHorseId !== null) {
    finishRace(winnerHorseId);
  }
}

async function finishRace(winnerHorseId: string) {
  if (currentState == State.RACE_FINISHED) return; // TODO check if this is really necessary

  updateState(State.RACE_FINISHED);
  if (updatePositionsInterval) clearInterval(updatePositionsInterval);

  const winnerHorse: RacingHorse = currentRaceHorses.find(
    (horse) => horse.id === winnerHorseId
  )!;

  // const winnerBets = currentBets.filter(bet => bet.horseId === winnerHorse.id);

  const winnerUsers = currentBets
    .filter((bet) => bet.horseId === winnerHorse.id)
    .reduce((map, bet) => {
      const profit = bet.amount * winnerHorse.odd;
      map.set(bet.userId, (map.get(bet.userId) || 0) + profit);
      return map;
    }, new Map<string, number>());

  const updatePromises = [];

  for (const [userId, profit] of winnerUsers) {
    updatePromises.push(
      db
        .update(users)
        .set({
          balance: sql`${users.balance} + ${profit}`,
        })
        .where(eq(users.id, userId))
    );
  }

  await Promise.all(updatePromises);

  // const updates = Array.from(winnerUsers).map(
  //   ([userId, profit]) => ({
  //     id: userId,
  //     profit,
  //   })
  // );

  // await db.execute(
  //   sql`UPDATE ${users}
  //          SET balance = balance + data.profit
  //          FROM (VALUES ${updates.map(
  //            ({ id, profit }) => sql`(${id}, ${profit})`
  //          )}) AS data(id, profit)
  //          WHERE ${users}.id = data.id`
  // );

  ioService.emitRaceResult({ winnerHorse });

  setTimeout(() => {
    if (pauseAfterThisRace) {
      updateState(State.PAUSED);
      pauseAfterThisRace = false;
      return;
    }

    startBettingPhase();
  }, INTERVAL_BETWEEN_RACES);
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
