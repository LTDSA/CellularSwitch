export type AppState =
  | { type: 'unsupported' }
  | { type: 'idle' }
  | { type: 'connected-original'; device: USBDevice }
  | { type: 'connected-modified'; device: USBDevice }
  | {
      type: 'processing'
      operation: 'modify' | 'restore'
      step: ProcessingStep
    }
  | { type: 'success'; operation: 'modify' | 'restore' }
  | { type: 'error'; message: string; recoverable: boolean; diagnostics?: string }

export type ProcessingStep =
  | 'sending'
  | 'waiting-reboot'
  | 'verifying'

export type ModuleMode = 'original' | 'modified' | 'unknown'
