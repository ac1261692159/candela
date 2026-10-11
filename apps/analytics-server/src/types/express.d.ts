import { PROJECT_KEY } from '../common/interceptors/project.interceptor';

declare global {
  namespace Express {
    interface Request {
      [PROJECT_KEY]: string;
    }
  }
}
