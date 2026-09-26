import { updateMovement } from "./movement.js";

export function stepSimulation(world, navigation, deltaSeconds, systems = []) {
    if (deltaSeconds <= 0) return;
    
    world.time += deltaSeconds;
    updateMovement(world, navigation, deltaSeconds);

    for (const system of systems) {
        system(world, navigation, deltaSeconds);
    }
}