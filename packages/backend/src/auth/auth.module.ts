import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MeController } from './me.controller';
import { CliAuthController } from './cli-auth.controller';
import { CliAuthService } from './cli-auth.service';
import { ApiKey } from '../entities/api-key.entity';
import { CliAuthCode } from '../entities/cli-auth-code.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ApiKey, CliAuthCode])],
  controllers: [MeController, CliAuthController],
  providers: [CliAuthService],
})
export class AuthModule {}
