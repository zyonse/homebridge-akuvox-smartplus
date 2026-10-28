import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { AkuvoxPlatform } from '../platform';
import { DoorRelay } from '../AkuvoxAPI';

export type AccessoryType = 'garage' | 'switch' | 'lock';

// Seconds an opened relay is shown as open before returning to closed
export const DEFAULT_OPEN_DURATION: Record<AccessoryType, number> = {
  garage: 60,
  switch: 1,
  lock: 10,
};

/**
 * A SmartPlus door relay exposed as a garage door, momentary switch, or lock
 * SmartPlus only fires the relay and never reports door position, so "open" is shown for a fixed time
 */
export class RelayAccessory {
  private readonly service: Service;
  private open = false;
  private resetTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: AkuvoxPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly relay: DoorRelay,
    private readonly type: AccessoryType,
    private readonly openDuration: number,
  ) {
    const { Service, Characteristic } = platform;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Akuvox')
      .setCharacteristic(Characteristic.Model, 'SmartPlus Relay')
      .setCharacteristic(Characteristic.SerialNumber, relay.id);

    const serviceTypes = {
      garage: Service.GarageDoorOpener,
      switch: Service.Switch,
      lock: Service.LockMechanism,
    };
    // Remove a service left over from a previously configured type
    for (const [otherType, serviceType] of Object.entries(serviceTypes)) {
      const stale = otherType !== type && accessory.getService(serviceType);
      if (stale) {
        accessory.removeService(stale);
      }
    }
    this.service = accessory.getService(serviceTypes[type]) || accessory.addService(serviceTypes[type]);
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    switch (type) {
      case 'garage':
        this.service.getCharacteristic(Characteristic.CurrentDoorState).onGet(() => this.doorState());
        this.service.getCharacteristic(Characteristic.TargetDoorState)
          .onGet(() => this.doorState())
          .onSet((value) => this.setOpen(value === Characteristic.TargetDoorState.OPEN));
        this.service.getCharacteristic(Characteristic.ObstructionDetected).onGet(() => false);
        break;
      case 'switch':
        this.service.getCharacteristic(Characteristic.On)
          .onGet(() => this.open)
          .onSet((value) => this.setOpen(value as boolean));
        break;
      case 'lock':
        this.service.getCharacteristic(Characteristic.LockCurrentState).onGet(() => this.lockState());
        this.service.getCharacteristic(Characteristic.LockTargetState)
          .onGet(() => this.lockState())
          .onSet((value) => this.setOpen(value === Characteristic.LockTargetState.UNSECURED));
        break;
    }
    this.publishState();
  }

  /**
   * Fire the relay when opening; closing only resets the displayed state since the relay is momentary
   */
  async setOpen(open: boolean) {
    clearTimeout(this.resetTimer);
    if (!open) {
      this.setDisplayedState(false);
      return;
    }

    this.platform.log.info(`Opening ${this.accessory.displayName}`);
    try {
      await this.platform.akuvox!.openDoor(this.relay);
    } catch (error) {
      this.platform.log.error(`Failed to open ${this.accessory.displayName}:`, (error as Error).message);
      // Snap the target back once HomeKit has processed the failed set
      setImmediate(() => this.publishState());
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.setDisplayedState(true);
    this.resetTimer = setTimeout(() => this.setDisplayedState(false), this.openDuration * 1000);
  }

  stop() {
    clearTimeout(this.resetTimer);
  }

  private setDisplayedState(open: boolean) {
    this.open = open;
    this.publishState();
  }

  private publishState() {
    const { Characteristic } = this.platform;
    switch (this.type) {
      case 'garage':
        this.service.updateCharacteristic(Characteristic.TargetDoorState, this.doorState());
        this.service.updateCharacteristic(Characteristic.CurrentDoorState, this.doorState());
        break;
      case 'switch':
        this.service.updateCharacteristic(Characteristic.On, this.open);
        break;
      case 'lock':
        this.service.updateCharacteristic(Characteristic.LockTargetState, this.lockState());
        this.service.updateCharacteristic(Characteristic.LockCurrentState, this.lockState());
        break;
    }
  }

  private doorState(): CharacteristicValue {
    const { CurrentDoorState } = this.platform.Characteristic;
    return this.open ? CurrentDoorState.OPEN : CurrentDoorState.CLOSED;
  }

  private lockState(): CharacteristicValue {
    const { LockCurrentState } = this.platform.Characteristic;
    return this.open ? LockCurrentState.UNSECURED : LockCurrentState.SECURED;
  }
}
