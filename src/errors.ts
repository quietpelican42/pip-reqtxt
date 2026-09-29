import { InvalidMarker, InvalidRequirement, InvalidSpecifier, InvalidVersion, InvalidWheelFilename, PySyntaxError } from './packaging.ts';
import { OptionCommandError, OptionParsingError } from './options.ts';
import { PyValueError } from './pyish.ts';
import { ShlexError } from './shlex.ts';

/** The Python exception class names pip can raise while reading a requirements file. */
export type PipErrorType =
  | 'RequirementsFileParseError'
  | 'InstallationError'
  | 'CommandError'
  | 'InvalidRequirement'
  | 'InvalidSpecifier'
  | 'InvalidEggFragment'
  | 'InvalidWheelFilename'
  | 'ValueError'
  | 'AssertionError'
  | 'SyntaxError'
  | 'UnicodeDecodeError'
  | 'LookupError'
  | 'URLError'
  | 'IsADirectoryError';

/** An error pip would raise, carrying pip's exception class name and message. */
export class PipError extends Error {
  readonly errorType: PipErrorType;
  constructor(errorType: PipErrorType, message: string) {
    super(message);
    this.errorType = errorType;
  }
}

/** Map an exception thrown by one of the ports to the pip exception it stands for. */
export function toPipError(e: unknown): PipError {
  if (e instanceof PipError) return e;
  if (e instanceof InvalidRequirement) return new PipError('InvalidRequirement', e.message);
  if (e instanceof InvalidSpecifier) return new PipError('InvalidSpecifier', e.message);
  if (e instanceof InvalidMarker) return new PipError('InvalidRequirement', e.message);
  if (e instanceof InvalidWheelFilename) return new PipError('InvalidWheelFilename', e.message);
  if (e instanceof InvalidVersion) return new PipError('ValueError', e.message);
  if (e instanceof PyValueError) return new PipError('ValueError', e.message);
  if (e instanceof PySyntaxError) return new PipError('SyntaxError', e.message);
  if (e instanceof OptionCommandError) return new PipError('CommandError', e.message);
  if (e instanceof OptionParsingError) return new PipError('RequirementsFileParseError', e.message);
  if (e instanceof ShlexError) return new PipError('RequirementsFileParseError', e.message);
  throw e;
}
