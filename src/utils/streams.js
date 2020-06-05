/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

// This file holds various utilities about streams.

import { Transform, Writable } from 'stream';
import crypto from 'crypto';
import { StringDecoder } from 'string_decoder';

import { getLogger, type Logger } from '../log';
import { assertExhaustiveCheck } from '../utils/flow';
import { BadRequestError, PayloadTooLargeError } from './errors';

/**
 * This transform computes a sha1 of the data passing through it, but otherwise
 * doesn't alter the data.
 */
export class HasherPassThrough extends Transform {
  log: Logger = getLogger('HasherPassThrough');
  sha1Hasher = crypto.createHash('sha1');

  // This variable holds the result of the sha operation, because `hash.digest`
  // can be called only once.
  sha1Result: string | null = null;

  _transform(
    chunk: string | Buffer,
    encoding: string,
    callback: (error?: Error) => mixed
  ) {
    this.sha1Hasher.update(chunk);
    this.push(chunk);
    callback();
  }

  // This method returns the computed sha1 from the data that passed through the
  // transform.
  sha1(): string {
    this.log.trace('sha1()');
    if (this.sha1Result === null) {
      this.sha1Result = this.sha1Hasher.digest('hex');
    }
    return this.sha1Result;
  }
}

/**
 * This transform's sole goal is to check that the size of the streamed data
 * stays within some limit.
 */
export class LengthCheckerPassThrough extends Transform {
  log: Logger = getLogger('LengthCheckerPassThrough');
  maxLength: number;
  length: number = 0;

  constructor(maxLength: number) {
    super();
    this.maxLength = maxLength;
  }

  _transform(
    chunk: string | Buffer,
    encoding: string,
    callback: (error?: Error) => mixed
  ) {
    this.length += chunk.length;
    this.log.verbose(
      'length-checker-length',
      `Added chunk's length is ${chunk.length}, current length is ${this.length}`
    );

    if (this.length > this.maxLength) {
      // Using debug instead of verbose will make it possible to assert it in
      // tests that we actually checked the length through this class.
      this.log.debug('length-checker-length-error');
      callback(new PayloadTooLargeError(this.maxLength));
      return;
    }

    this.push(chunk);
    callback();
  }
}

/**
 * This writable stream keeps all received chunks until the stream is closed.
 * Then the chunks are concatenated into a unique Buffer that can be retrieved.
 */
export class Concatenator extends Writable {
  log: Logger = getLogger('Concatenator');
  chunks: Buffer[] = [];
  contents: Buffer | null = null;

  constructor() {
    super({ decodeStrings: false });
  }

  _write(
    chunk: string | Buffer,
    encoding: string,
    callback: (error?: Error) => mixed
  ) {
    if (!(chunk instanceof Buffer)) {
      callback(new Error(`This stream doesn't support strings.`));
      return;
    }

    this.chunks.push(chunk);
    callback();
  }

  _destroy(err: ?Error, callback: (error?: Error) => mixed) {
    this.log.trace('_destroy()');
    this.chunks.length = 0;
    this.contents = null;

    // Passthrough the error information, if present.
    // This line is needed because of the slightly inconsistent
    // signature of callback vs err, and that we can't change.
    err = err || undefined;
    callback(err);
  }

  _final(callback: (error?: Error) => mixed) {
    this.log.trace('_final()');
    this.contents = Buffer.concat(this.chunks);
    this.chunks.length = 0;
    callback();
  }

  transferContents(): Buffer {
    this.log.trace('transferContents()');
    const contents = this.contents;
    if (contents === null) {
      throw new Error(`Can't transfer before the stream has been closed.`);
    }
    this.contents = null;
    return contents;
  }
}

// This Transform cheaply checks that a gzipped stream looks like a json.
export class CheapJsonChecker extends Writable {
  log: Logger = getLogger('CheapJsonChecker');
  stringDecoder = new StringDecoder('utf8');
  // We allow either only spaces, or only spaces followed by a bracket, or just a bracket.
  onlySpacesRe = /^\s+$/;
  spacesAndBracketRe = /^\s*{/;
  checkEnded: boolean = false;

  errorMessage = `The payload isn't a JSON object.`;

  checkIsContentAllowed(content: string): 'notfound' | 'found' | 'error' {
    const gotOnlySpaces = this.onlySpacesRe.test(content);
    if (gotOnlySpaces) {
      return 'notfound';
    }

    const gotBracket = this.spacesAndBracketRe.test(content);
    if (gotBracket) {
      return 'found';
    }

    // Else this means we got something that doesn't look like the start of a
    // JSON object.
    return 'error';
  }

  _write(
    chunk: string | Buffer,
    encoding: string,
    callback: (error?: Error) => void
  ) {
    if (!(chunk instanceof Buffer)) {
      callback(new Error(`This stream doesn't support strings.`));
      return;
    }

    if (this.checkEnded) {
      callback();
      return;
    }

    const stringedChunk = this.stringDecoder.write(chunk);
    if (stringedChunk) {
      const checkResult = this.checkIsContentAllowed(stringedChunk);
      switch (checkResult) {
        case 'notfound':
          this.log.verbose(
            'json-not-found',
            'We still do not know if this is a json.'
          );
          callback();
          return;
        case 'found':
          this.log.verbose('json-found', 'This stream looks like a JSON.');
          this.checkEnded = true;
          callback();
          // This stream did what it's for so let's clean it up.
          // Calling end will also stop any piping gracefully.
          // Using nextTick allows some bufferred write to finish.
          process.nextTick(() => this.end());
          return;
        case 'error':
          this.log.verbose(
            'json-error',
            'This stream does not look like a JSON.'
          );
          callback(new BadRequestError(this.errorMessage));
          return;
        default:
          throw assertExhaustiveCheck(checkResult);
      }
    }
  }

  // This is called when all the data has been given to _transform and the
  // stream is ended.
  _final(callback: (error?: Error) => void) {
    this.log.trace('_final()');
    if (this.checkEnded) {
      callback();
      return;
    }

    // If we're coming here, this means we never finished checking. Let's
    // happily throw, then!
    callback(new BadRequestError(this.errorMessage));
  }
}
