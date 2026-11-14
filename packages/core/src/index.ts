export * from "./contracts.js";
export * from "./config.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
