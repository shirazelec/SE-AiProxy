// Imported first by server.js so even startup messages from other modules reach logs/proxy.log
import { installFileLogger } from './logger.js';

installFileLogger();
