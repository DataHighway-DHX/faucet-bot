import { ApiPromise } from "@polkadot/api";
import { template, add } from "lodash";
import BN from "bignumber.js";
import { ITuple } from "@polkadot/types/types";
import { DispatchError } from "@polkadot/types/interfaces";
import { ApiOptions } from "@polkadot/api/types";
import { KeyringPair } from "@polkadot/keyring/types";
import { Config } from "../util/config";
import { Storage } from "../util/storage";
import { SendConfig, MessageHandler } from "../types";
import { TaskQueue, TaskData } from "../task-queue";
import logger from "../util/logger";
import { info } from "console";

interface FaucetServiceConfig {
  account: KeyringPair;
  template: Config["template"];
  config: Config["faucet"];
  storage: Storage;
  taskQueue: TaskQueue;
}

interface FaucetParams {
  address: string;
  strategy: string;
  channel: {
    name: string;
    account: string;
  } & Record<string, string>;
}

export function formatToReadable(
  num: string | number,
  precision: number
): string {
  return new BN(num).div(new BN(10 ** precision)).toFixed(4);
}

export function formatToSendable(
  num: string | number,
  precision: number
): string {
  return new BN(num).multipliedBy(new BN(10 ** precision)).toFixed(0);
}

export class Service {
  public api!: ApiPromise;
  private account: KeyringPair;
  private template: Config["template"];
  private config: Config["faucet"];
  private storage: Storage;
  private taskQueue: TaskQueue;
  private sendMessageHandler!: Record<string, MessageHandler>;
  private killCountdown: number = 1000 * 60;
  private delayedKillTimeout!: NodeJS.Timeout | null;

  constructor({
    account,
    config,
    template,
    storage,
    taskQueue,
  }: FaucetServiceConfig) {
    this.account = account;
    this.config = config;
    this.template = template;
    this.storage = storage;
    this.taskQueue = taskQueue;
    this.sendMessageHandler = {};

    this.onConnected = this.onConnected.bind(this);
    this.onDisconnected = this.onDisconnected.bind(this);
  }

  private onConnected() {
    if (this.delayedKillTimeout) {
      clearTimeout(this.delayedKillTimeout);
      this.delayedKillTimeout = null;
    }
  }

  private onDisconnected() {
    this.delayedKillTimeout = setTimeout(() => {
      process.exit(1);
    }, this.killCountdown);
  }

  public async connect(options: ApiOptions) {
    this.api = await ApiPromise.create(options);

    await this.api.isReady.catch(() => {
      throw new Error("connect failed");
    });

    this.api.on("disconnected", this.onDisconnected);

    this.api.on("connected", this.onConnected);

    this.taskQueue.process((task: TaskData) => {
      return this.sendTokens(task.params)
        .then((tx: string) => {
          const sendMessage = this.sendMessageHandler[task.channel.name];

          if (!sendMessage) return;

          logger.info(
            `send success, ${JSON.stringify(task.channel)} ${JSON.stringify(
              task.params
            )}`
          );
          sendMessage(
            task.channel,
            `DHX: ${formatToReadable(
              task.params.balance,
              this.config.precision
            )}`,
            tx
          );
        })
        .catch(logger.error);
    });
  }

  public registMessageHander(channel: string, handler: MessageHandler) {
    this.sendMessageHandler[channel] = handler;
  }

  public async queryBalance() {
    this.api.query.system.account(this.account.address);
    const info = await this.api.query.system.account(this.account.address)
    return [{
      token: 'DHX',
      balance: info.data.free.toString()
    }];
  }

  public async getChainName() {
    return this.api.rpc.system.chain();
  }

  public async sendTokens(config: SendConfig) {
    let success: (value: any) => void;
    let failed: (resone: any) => void;

    const resultPromise = new Promise<string>((resolve, reject) => {
      success = resolve;
      failed = reject;
    });

    const tx = this.buildTx(config);

    const sigendTx = await tx.signAsync(this.account);

    const unsub = await sigendTx
      .send((result) => {
        if (result.isCompleted) {
          // extra message to ensure tx success
          let flag = true;
          let errorMessage: DispatchError["type"] = "";

          for (const event of result.events) {
            const { data, method, section } = event.event;

            if (section === "utility" && method === "BatchInterrupted") {
              flag = false;
              errorMessage = "batch error";
              break;
            }

            // if extrinsic failed
            if (section === "system" && method === "ExtrinsicFailed") {
              const [dispatchError] = (data as unknown) as ITuple<
                [DispatchError]
              >;

              // get error message
              if (dispatchError.isModule) {
                try {
                  const mod = dispatchError.asModule;
                  const error = this.api.registry.findMetaError(
                    new Uint8Array([Number(mod.index), Number(mod.error)])
                  );

                  errorMessage = `${error.section}.${error.name}`;
                } catch (error) {
                  // swallow error
                  errorMessage = "Unknown error";
                }
              }
              flag = false;
              break;
            }
          }

          if (flag) {
            success(sigendTx.hash.toString());
          } else {
            failed(errorMessage);
          }

          unsub && unsub();
        }
      })
      .catch((e) => {
        failed(e);
      });

    return resultPromise;
  }

  public buildTx(config: SendConfig) {
    return this.api.tx.balances.transfer(config.dest, config.balance);
  }

  usage() {
    return this.template.usage;
  }

  async faucet({ strategy, address, channel }: FaucetParams): Promise<any> {
    logger.info(
      `requect faucet, ${JSON.stringify(
        strategy
      )}, ${address}, ${JSON.stringify(channel)}`
    );

    const strategyDetail = this.config.strategy[strategy];

    try {
      await this.taskQueue.checkPendingTask();
    } catch (e) {
      throw new Error(this.getErrorMessage("PADDING_TASK_MAX"));
    }

    if (!strategyDetail) {
      throw new Error(this.getErrorMessage("NO_STRAGEGY"));
    }

    // check address limit
    let currentCount = 0;
    try {
      currentCount = await this.storage.getKeyCount(`address_${address}`);
    } catch (e) {
      throw new Error(this.getErrorMessage("CHECK_LIMIT_FAILED"));
    }

    if (strategyDetail.limit && currentCount >= strategyDetail.limit) {
      throw new Error(
        this.getErrorMessage("LIMIT", { account: channel.account || address })
      );
    }

    // check build tx
    const amount = strategyDetail.amount;
    const params = {
      balance: formatToSendable(amount, this.config.precision),
      dest: address,
    };

    try {
      this.buildTx(params);
    } catch (e) {
      logger.error(e);

      throw new Error(this.getErrorMessage("CHECK_TX_FAILED", { error: e }));
    }

    // increase address limit count
    try {
      await this.storage.incrKeyCount(
        `address_${address}`,
        strategyDetail.frequency
      );
    } catch (e) {
      throw new Error(this.getErrorMessage("UPDATE_LIMIT_FAILED"));
    }

    try {
      const result = await this.taskQueue.insert({
        channel: channel,
        params: params,
      });

      return result;
    } catch (e) {
      logger.error(e);

      await this.storage.decrKeyCount(`address_${address}`);

      throw new Error(this.getErrorMessage("INSERT_TASK_FAILED"));
    }
  }

  getErrorMessage(code: string, params?: any) {
    return template(this.template.error[code] || "Faucet error.")(params);
  }

  getMessage(name: string, params?: any) {
    return template(this.template[name] || "Empty")(params);
  }
}
