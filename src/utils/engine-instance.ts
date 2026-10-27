/**
 * This engine process (the daemon that hosts the actors): a new id each time it starts. Push locks name the instance
 * that holds them, and a driver compares it before and after a failed attempt to tell a daemon restart from a fault.
 */
export const ENGINE_INSTANCE = crypto.randomUUID();
