/**
 * Copyright 2025 Ceeblue B.V.
 * This file is part of https://github.com/CeeblueTV/wrts-client which is released under GNU Affero General Public License.
 * See file LICENSE or go to https://spdx.org/licenses/AGPL-3.0-or-later.html for full license details.
 */

/**
 * The CMCD type with 'full' or 'short' sending informations
 * or 'none' to disable CMCD
 */
export enum CMCD {
    NONE = 'none',
    SHORT = 'short', // just the necessary metrics
    FULL = 'full'
}

/**
 * The CMCD delivery method, 'header' to send the CMCD in the headers
 * or 'query' to send it in the query string
 */
export enum CMCDMode {
    HEADER = 'header',
    QUERY = 'query'
}

/**
 * Interface CMCD to implement for the CMCD options
 */
export interface ICMCD {
    /**
     * The {@link CMCD} type
     * @defaultValue {@link CMCD.NONE|'none'}
     */
    get cmcd(): CMCD;

    /**
     * Set the {@link CMCD} type,
     * if undefined reset to defaultValue {@link CMCD.NONE|'none'}
     */
    set cmcd(value: CMCD | undefined);

    /**
     * The {@link CMCDMode}
     * @defaultValue {@link CMCDMode.HEADER|'header'}
     */
    get cmcdMode(): CMCDMode;

    /**
     * Set the {@link CMCDMode},
     * if undefined reset to defaultValue {@link CMCDMode.HEADER|'header'}
     */
    set cmcdMode(value: CMCDMode | undefined);

    /**
     * The CMCD session ID
     */
    get cmcdSid(): string;

    /**
     * Set the CMCD session ID,
     * if undefined reset to empty string
     */
    set cmcdSid(value: string | undefined);
}
