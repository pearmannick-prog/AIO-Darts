// api-error.js - the one error type the API layer understands.
//
// In its own file, rather than in api.js, purely to break a cycle: api.js
// imports the modules that do the work (matches.js and its successors), and
// those modules need to raise errors that api.js knows how to render. Importing
// it back from api.js would make that a circle.
//
// Anything thrown that is NOT an ApiError is treated as a bug: logged with its
// detail, reported to the caller as a generic 500. So throwing one of these is
// how a module says "this is the user's problem, and here is what to tell
// them" - the message is shown verbatim in the UI.
export class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
