import Redis from "ioredis";
import { config } from "./config";

const redis = new Redis(config.REDIS_URL);

export default redis;
