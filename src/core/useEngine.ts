import { useSyncExternalStore } from 'react';
import { engineController, type EngineController } from './engine';

export function useEngine(controller: EngineController = engineController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
