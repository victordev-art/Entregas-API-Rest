export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what) => new AppError(404, 'nao_encontrado', `${what} não encontrado(a)`);
export const conflict = (code, msg) => new AppError(409, code, msg);
export const unprocessable = (code, msg) => new AppError(422, code, msg);
