import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6380/0");

export default redis;
