/*
    For the request to be sent, one of the two conditions has to be true:
        a callback was passed to the request
        a promise was retrieved from the request

    Number of times "onComplete" event is fired:
                |   w/o promise()   |   w/ promise()
    no callback |       0           |       1    
    callback    |       1           |       2   
 */
import { BasePlugin } from "@opentelemetry/core";
import { Span, CanonicalCode } from "@opentelemetry/api";
import * as shimmer from "shimmer";
import AWS from "aws-sdk";
import { AttributeNames } from "./enums";
import {
  getRequestServiceAttributes,
  getResponseServiceAttributes,
} from "./services";
import { AwsSdkPluginConfig } from "./types";

const VERSION = "0.0.4";

class AwsPlugin extends BasePlugin<typeof AWS> {
  readonly component: string;
  protected _config: AwsSdkPluginConfig;
  private REQUEST_SPAN_KEY = Symbol("opentelemetry.plugin.aws-sdk.span");

  constructor(readonly moduleName: string) {
    super(`opentelemetry-plugin-aws-sdk`, VERSION);
  }

  protected patch() {
    this._logger.debug(
      "applying patch to %s@%s",
      this.moduleName,
      this.version
    );

    shimmer.wrap(
      this._moduleExports?.Request.prototype,
      "send",
      this._getRequestSendPatch.bind(this)
    );
    shimmer.wrap(
      this._moduleExports?.Request.prototype,
      "promise",
      this._getRequestPromisePatch.bind(this)
    );

    return this._moduleExports;
  }

  protected unpatch() {
    shimmer.unwrap(this._moduleExports?.Request.prototype, "send");
    shimmer.unwrap(this._moduleExports?.Request.prototype, "promise");
  }

  private _bindPromise(target: Promise<any>, span: Span) {
    const thisPlugin = this;

    const origThen = target.then;
    target.then = function (onFulfilled, onRejected) {
      const newOnFulfilled = thisPlugin._tracer.bind(onFulfilled, span);
      const newOnRejected = thisPlugin._tracer.bind(onRejected, span);
      return origThen.call(this, newOnFulfilled, newOnRejected);
    };

    return target;
  }

  private _startAwsSpan(request: AWS.Request<any, any>): Span {
    const operation = (request as any).operation;
    const service = (request as any).service;

    const newSpan = this._tracer.startSpan(this._getSpanName(request), {
      attributes: {
        [AttributeNames.COMPONENT]: this.moduleName,
        [AttributeNames.AWS_OPERATION]: operation,
        [AttributeNames.AWS_SIGNATURE_VERSION]:
          service?.config?.signatureVersion,
        [AttributeNames.AWS_REGION]: service?.config?.region,
        [AttributeNames.AWS_SERVICE_API]: service?.api?.className,
        [AttributeNames.AWS_SERVICE_IDENTIFIER]: service?.serviceIdentifier,
        [AttributeNames.AWS_SERVICE_NAME]: service?.api?.abbreviation,
        ...getRequestServiceAttributes(request),
      },
    });

    request[this.REQUEST_SPAN_KEY] = newSpan;
    return newSpan;
  }

  private _callPreRequestHooks(span: Span, request: AWS.Request<any, any>) {
    if (this._config?.preRequestHook) {
      this._safeExecute(
        span,
        () => this._config.preRequestHook(span, request),
        false
      );
    }
  }

  private _registerCompletedEvent(span: Span, request: AWS.Request<any, any>) {
    const thisPlugin = this;
    request.on("complete", (response) => {
      if (!request[thisPlugin.REQUEST_SPAN_KEY]) {
        return;
      }
      request[thisPlugin.REQUEST_SPAN_KEY] = undefined;

      if (response.error) {
        span.setAttribute(AttributeNames.AWS_ERROR, response.error);
      }

      span.setAttributes({
        [AttributeNames.AWS_REQUEST_ID]: response.requestId,
        ...getResponseServiceAttributes(response),
      });
      span.end();
    });
  }

  private _getRequestSendPatch(
    original: (callback?: (err: any, data: any) => void) => void
  ) {
    const thisPlugin = this;
    return function (callback?: (err: any, data: any) => void) {
      const awsRequest: AWS.Request<any, any> = this;
      /* 
        if the span was already started, we don't want to start a new one 
        when Request.promise() is called
      */
      if (
        this._asm.currentState === "complete" ||
        awsRequest[thisPlugin.REQUEST_SPAN_KEY]
      ) {
        return original.apply(this, arguments);
      }

      const span = thisPlugin._startAwsSpan(awsRequest);
      thisPlugin._callPreRequestHooks(span, awsRequest);
      thisPlugin._registerCompletedEvent(span, awsRequest);

      return thisPlugin._tracer.withSpan(span, () => {
        return original.call(awsRequest, callback);
      });
    };
  }

  private _getRequestPromisePatch(original: () => Promise<any>) {
    const thisPlugin = this;
    return function (): Promise<any> {
      const awsRequest: AWS.Request<any, any> = this;
      /* 
        if the span was already started, we don't want to start a new one 
        when Request.promise() is called
      */
      if (
        this._asm.currentState === "complete" ||
        awsRequest[thisPlugin.REQUEST_SPAN_KEY]
      ) {
        return original.apply(this, arguments);
      }

      const span = thisPlugin._startAwsSpan(awsRequest);
      thisPlugin._callPreRequestHooks(span, awsRequest);
      thisPlugin._registerCompletedEvent(span, awsRequest);

      const promiseToReturn: Promise<any> = thisPlugin._tracer.withSpan(
        span,
        () => {
          return original.apply(awsRequest, arguments);
        }
      );
      return thisPlugin._bindPromise(promiseToReturn, span);
    };
  }

  private _getSpanName = (request: any) => {
    return `aws.${request.service?.serviceIdentifier ?? "request"}.${
      request.operation
    }`;
  };

  private _safeExecute<
    T extends (...args: unknown[]) => ReturnType<T>,
    K extends boolean
  >(
    span: Span,
    execute: T,
    rethrow: K
  ): K extends true ? ReturnType<T> : ReturnType<T> | void;
  private _safeExecute<T extends (...args: unknown[]) => ReturnType<T>>(
    span: Span,
    execute: T,
    rethrow: boolean
  ): ReturnType<T> | void {
    try {
      return execute();
    } catch (error) {
      if (rethrow) {
        span.setStatus({
          code: CanonicalCode.UNKNOWN,
        });
        span.end();
        throw error;
      }
      this._logger.error("caught error ", error);
    }
  }
}

export const plugin = new AwsPlugin("aws-sdk");
