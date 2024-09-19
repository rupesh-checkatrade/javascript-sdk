import exp from "constants";
import { AsyncTransformer, AsyncProducer } from "../type";
import { scheduleMicrotask } from "../microtask";

export interface Repeater {
  start(immediateExecution?: boolean): void;
  stop(): void;
  setTask(task: AsyncTransformer<number, void>): void;
}

export interface BackoffController {
  backoff(): number;
  reset(): void;
}

export class ExponentialBackoff implements BackoffController {
  private base: number;
  private max: number;
  private current: number;
  private maxJitter: number;

  constructor(base: number, max: number, maxJitter: number) {
    this.base = base;
    this.max = max;
    this.maxJitter = maxJitter;
    this.current = base;
  }

  backoff(): number {
    const ret = this.current + this.maxJitter * Math.random();
    this.current = Math.min(this.current * 2, this.max);
    return ret;
  }

  reset(): void {
    this.current = this.base;
  }
}

export class IntervalRepeater implements Repeater {
  private timeoutId?: NodeJS.Timeout;
  private task?: AsyncTransformer<number, void>;
  private interval: number;
  private failureCount = 0;
  private backoffController?: BackoffController;
  private isRunning = false;

  constructor(interval: number, backoffController?: BackoffController) {
    this.interval = interval;
    this.backoffController = backoffController;
  }

  private handleSuccess() {
    this.failureCount = 0;
    this.backoffController?.reset();
    this.setTimer(this.interval);
  }

  private handleFailure() {
    this.failureCount++;
    const time = this.backoffController?.backoff() ?? this.interval;
    this.setTimer(time);
  }

  private setTimer(timeout: number) {
    if (!this.isRunning){
      return;
    }
    this.timeoutId = setTimeout(this.executeHandler.bind(this), timeout);
  }

  private executeHandler() {
    if (!this.task) {
      return;
    }
    this.task(this.failureCount).then(
      this.handleSuccess.bind(this),
      this.handleFailure.bind(this)
    );
  }

  start(immediateExecution?: boolean): void {
    this.isRunning = true;
    if(immediateExecution) {
      scheduleMicrotask(this.executeHandler.bind(this));
    } else {
      this.setTimer(this.interval);
    }
  }

  stop(): void {
    this.isRunning = false;
    clearInterval(this.timeoutId);
  }

  reset(): void {
    this.backoffController?.reset();
    this.stop();
  }

  setTask(task: AsyncTransformer<number, void>): void {
    this.task = task;
  }
}
