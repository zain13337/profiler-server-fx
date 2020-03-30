/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// @flow

// This router implements the url shortening functionality, using bitly.

import Router from '@koa/router';
import jwt from 'koa-jwt';

import { getLogger } from '../log';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../utils/errors';
import { config } from '../config';
import { create as gcsStorageCreate } from '../logic/gcs';
import type { ErrorResponse } from '@google-cloud/storage';
import type { Middleware } from '@koa/router';

export function profileRoutes() {
  const log = getLogger('routes.profile');
  const router = new Router();

  /**
   * This route handles profile deletion. A user can delete a profile if they
   * have a valid JWT token that contains the profile's token (currently a hash).
   * The JWT token is signed by a private key on the profiler server, so we can
   * trust that it is only held by a user who published the profile.
   */
  router.delete(
    '/profile/:profileToken',
    jwt({
      secret: config.jwtSecret,
      algorithms: ['HS256'],
      key: 'jwtData',
    }),
    (async ctx => {
      // Verify there is a valid profileToken in the URL path.
      if (!ctx.params.profileToken) {
        throw new BadRequestError(
          `Expected to get a profile token in the path of the form "/delete-profile/PROFILE_TOKEN"`
        );
      }

      // Verify there is a valid JWT token.
      let profileToken: string;
      const jwtData: mixed = ctx.state.jwtData;
      if (
        !jwtData ||
        typeof jwtData !== 'object' ||
        typeof jwtData.profileToken !== 'string'
      ) {
        throw new ForbiddenError(`A profileToken was not found in the JWT.`);
      } else {
        profileToken = jwtData.profileToken;
      }

      // Make sure the profile token from the route and JWT agree.
      if (profileToken !== ctx.params.profileToken) {
        throw new ForbiddenError(
          'The profileToken in the JWT did not match the token provided in the path.'
        );
      }

      log.info(
        'delete',
        'Attempt to delete the profile from Google Cloud Storage.'
      );
      const storage = gcsStorageCreate(config);
      try {
        await storage.deleteFile(profileToken);
      } catch (error) {
        if ('code' in error && 'message' in error) {
          const { code } = (error: ErrorResponse);
          if (code === 404) {
            throw new NotFoundError(
              'That profile was most likely already deleted.'
            );
          }
          throw error;
        }
        console.log(error);
      }

      ctx.body = 'Profile successfully deleted.';
    }: Middleware)
  );

  return router;
}
