/**
 * Copyright 2023, Optimizely
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { LOG_MESSAGES } from './../../utils/enums/index';
import { getLogger, LogHandler, LogLevel } from '../../modules/logging';
import { ERROR_MESSAGES, ODP_USER_KEY } from '../../utils/enums';

import { VuidManager } from '../../plugins/vuid_manager';

import { OdpConfig } from './odp_config';
import { IOdpEventManager } from './odp_event_manager';
import { IOdpSegmentManager } from './odp_segment_manager';
import { OptimizelySegmentOption } from './optimizely_segment_option';
import { invalidOdpDataFound } from './odp_utils';
import { OdpEvent } from './odp_event';
import { resolvablePromise } from '../../utils/promise/resolvablePromise';

/**
 * Manager for handling internal all business logic related to
 * Optimizely Data Platform (ODP) / Advanced Audience Targeting (AAT)
 */
export interface IOdpManager {
  onReady(): Promise<unknown>;
  // initPromise?: Promise<void>;

  // enabled: boolean;
  isReady(): boolean;

  segmentManager: IOdpSegmentManager | undefined;

  eventManager: IOdpEventManager | undefined;

  updateSettings(odpConfig: OdpConfig): boolean;

  stop(): void;

  fetchQualifiedSegments(userId: string, options?: Array<OptimizelySegmentOption>): Promise<string[] | null>;

  identifyUser(userId?: string, vuid?: string): void;

  sendEvent({ type, action, identifiers, data }: OdpEvent): void;

  isVuidEnabled(): boolean;

  getVuid(): string | undefined;
}

enum Status {
  Running,
  Stopped,
}

/**
 * Orchestrates segments manager, event manager, and ODP configuration
 */
export abstract class OdpManager implements IOdpManager {
  /**
   * Promise that returns when the OdpManager is finished initializing
   */
  initPromise: Promise<unknown>;
  
  private ready: boolean = false;

  /**
   * Promise that resolves when odpConfig becomes available
   */
  configPromise: resolvablePromise<void>;

  status: Status;

  /**
   * ODP Segment Manager which provides an interface to the remote ODP server (GraphQL API) for audience segments mapping.
   * It fetches all qualified segments for the given user context and manages the segments cache for all user contexts.
   */
  segmentManager: IOdpSegmentManager;

  /**
   * ODP Event Manager which provides an interface to the remote ODP server (REST API) for events.
   * It will queue all pending events (persistent) and send them (in batches of up to 10 events) to the ODP server when possible.
   */
  eventManager: IOdpEventManager;

  /**
   * Handler for recording execution logs
   * @protected
   */
  protected logger: LogHandler = getLogger(); // TODO: Consider making private and moving instantiation to constructor

  /**
   * ODP configuration settings for identifying the target API and segments
   */
  // odpConfig: OdpConfig = new OdpConfig(); // TODO: Consider making private and adding public accessors
  odpConfig?: OdpConfig;

  // TODO: Consider accepting logger as a parameter and initializing it in constructor instead
  private constructor({
    odpConfig,
    vuidManager,
    segmentManger,
    eventManager,
  }: {
    odpConfig?: OdpConfig;
    vuidManager: VuidManager;
    segmentManger: IOdpSegmentManager;
    eventManager: IOdpEventManager;
  }) {
    // this.enabled = !!odpConfig;
    this.odpConfig = odpConfig;
    this.segmentManager = segmentManger;
    this.eventManager = eventManager;
    this.configPromise = resolvablePromise();

    const readineessDependencies = [this.configPromise];

    if (this.isVuidEnabled()) {
      readineessDependencies.push(this.initializeVuid());
    }

    this.initPromise = Promise.all(readineessDependencies);

    this.onReady().then(() => {
      this.ready = true;
      if(this.isVuidEnabled()) {
        this.registerVuid();
      }
    });

    if (odpConfig) {
      this.updateSettings(odpConfig);
    }
  }

  start(odpConfig?: OdpConfig): Promise<void> {
    if (odpConfig) {
      this.odpConfig = odpConfig;
    }
    
    if (!this.odpConfig) {
      return Promise.reject(new Error('cannot start without ODP config'));      
    }

    if (!this.odpConfig.integrated) {
      return Promise.reject(new Error('start() called with non-integrated ODP config'));
    }

    this.configPromise.resolve();
    this.status = Status.Running;
    this.segmentManager.updateSettings(this.odpConfig);
    this.eventManager.updateSettings(this.odpConfig);
  }

  // stop(): Promise<void> {
  //   return Promise.resolve();
  // }

  onReady(): Promise<unknown> {
    return this.initPromise;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Provides a method to update ODP Manager's ODP Config
   */
  updateSettings(odpConfig: OdpConfig): boolean {
    // do nothing if config did not change
    if (this.odpConfig && this.odpConfig.equals(odpConfig)) {
      return false;
    }

    if (odpConfig.integrated) {
      // already running, just propagate updated config to children;
      if (this.status === Status.Running) {
        this.segmentManager.updateSettings(odpConfig);
        this.eventManager.updateSettings(odpConfig);
      } else {
        this.start(odpConfig);
      }
    }

    // if (!odpConfig.integrated) {
    //   this.close();
    // }

    // this.eventManager.flush();

    // const newConfig = new OdpConfig(apiKey, apiHost, pixelUrl, segmentsToCheck);
    // const configDidUpdate = this.odpConfig.update(newConfig);

    // if (configDidUpdate) {
    //   this.odpConfig.update(newConfig);
    //   this.segmentManager?.reset();
    //   return true;
    // }

    // return false;
  }

  /**
   * Attempts to stop the current instance of ODP Manager's event manager, if it exists and is running.
   */
  stop(): void {
    if (!this.enabled) {
      return;
    }

    this.eventManager?.stop();
  }

  /**
   * Attempts to fetch and return a list of a user's qualified segments from the local segments cache.
   * If no cached data exists for the target user, this fetches and caches data from the ODP server instead.
   * @param {string}                          userId  - Unique identifier of a target user.
   * @param {Array<OptimizelySegmentOption>}  options - An array of OptimizelySegmentOption used to ignore and/or reset the cache.
   * @returns {Promise<string[] | null>}      A promise holding either a list of qualified segments or null.
   */
  async fetchQualifiedSegments(userId: string, options: Array<OptimizelySegmentOption> = []): Promise<string[] | null> {
    if (!this.enabled) {
      this.logger.log(LogLevel.ERROR, ERROR_MESSAGES.ODP_NOT_ENABLED);
      return null;
    }

    if (!this.segmentManager) {
      this.logger.log(LogLevel.ERROR, ERROR_MESSAGES.ODP_FETCH_QUALIFIED_SEGMENTS_SEGMENTS_MANAGER_MISSING);
      return null;
    }

    if (VuidManager.isVuid(userId)) {
      return this.segmentManager.fetchQualifiedSegments(ODP_USER_KEY.VUID, userId, options);
    }

    return this.segmentManager.fetchQualifiedSegments(ODP_USER_KEY.FS_USER_ID, userId, options);
  }

  /**
   * Identifies a user via the ODP Event Manager
   * @param {string}  userId    (Optional) Custom unique identifier of a target user.
   * @param {string}  vuid      (Optional) Secondary unique identifier of a target user, primarily used by client SDKs.
   * @returns
   */
  identifyUser(userId?: string, vuid?: string): void {
    if (!this.enabled) {
      this.logger.log(LogLevel.DEBUG, LOG_MESSAGES.ODP_IDENTIFY_FAILED_ODP_DISABLED);
      return;
    }

    if (!this.odpConfig.isReady()) {
      this.logger.log(LogLevel.DEBUG, LOG_MESSAGES.ODP_IDENTIFY_FAILED_ODP_NOT_INTEGRATED);
      return;
    }

    if (!this.eventManager) {
      this.logger.log(LogLevel.ERROR, ERROR_MESSAGES.ODP_IDENTIFY_FAILED_EVENT_MANAGER_MISSING);
      return;
    }

    if (userId && VuidManager.isVuid(userId)) {
      this.eventManager.identifyUser(undefined, userId);
      return;
    }

    this.eventManager.identifyUser(userId, vuid);
  }

  /**
   * Sends an event to the ODP Server via the ODP Events API
   * @param {OdpEvent}  > ODP Event to send to event manager
   */
  sendEvent({ type, action, identifiers, data }: OdpEvent): void {
    let mType = type;

    if (typeof mType !== 'string' || mType === '') {
      mType = 'fullstack';
    }

    if (!this.enabled) {
      throw new Error(ERROR_MESSAGES.ODP_NOT_ENABLED);
    }

    if (!this.odpConfig.isReady()) {
      throw new Error(ERROR_MESSAGES.ODP_NOT_INTEGRATED);
    }

    if (invalidOdpDataFound(data)) {
      throw new Error(ERROR_MESSAGES.ODP_INVALID_DATA);
    }

    if (!this.eventManager) {
      throw new Error(ERROR_MESSAGES.ODP_SEND_EVENT_FAILED_EVENT_MANAGER_MISSING);
    }

    if (typeof action !== 'string' || action === '') {
      throw new Error('ODP action is not valid (cannot be empty).');
    }

    this.eventManager.sendEvent(new OdpEvent(mType, action, identifiers, data));
  }

  /**
   * Identifies if the VUID feature is enabled
   */
  abstract isVuidEnabled(): boolean;

  /**
   * Returns VUID value if it exists
   */
  abstract getVuid(): string | undefined;

  protected initializeVuid(): Promise<void> {
    return Promise.resolve();
  }

  private registerVuid() {
    const vuid = this.getVuid();
    if (!vuid) {
      return;
    }

    try {
      this.eventManager.registerVuid(vuid);
    } catch (e) {
      this.logger.log(LogLevel.ERROR, ERROR_MESSAGES.ODP_VUID_REGISTRATION_FAILED);
    }
  }
}
