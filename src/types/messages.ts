export interface WSMessage<T = unknown> {
  type: string;
  payload: T;
  timestamp?: number;
}
