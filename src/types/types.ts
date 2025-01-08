import type { JwtPayload } from '@clerk/types';

export enum State {
  PAUSED = "PAUSED",
  OPEN_TO_BETS = "OPEN_TO_BETS",
  RACE_STARTING = "RACE_STARTING",
  RACING = "RACING",
  RACE_FINISHED = "RACE_FINISHED",
}

export type User = {
  id: string;
  username: string;
  balance: number;
};

export type Horse = {
  id: string;
  name: string;
};

export type RacingHorse = Horse & {
  odd: number;
};

export type Bet = {
  userId: string;
  horseId: string;
  amount: number;
};

export type HorsePosition = {
  horseId: string;
  position: number;
};

export type Status = {
  state: State;
  currentRaceHorses?: RacingHorse[];
  currentRacePositions?: HorsePosition[];
};

export type Roles = 'admin' | 'moderator'

export type CustomJwtSessionClaims = JwtPayload &  {
  metadata: {
    role?: Roles
  }
}
