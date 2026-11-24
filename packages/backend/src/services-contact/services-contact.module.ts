import { Module } from '@nestjs/common';
import { ServicesContactController } from './services-contact.controller';

@Module({
  controllers: [ServicesContactController],
})
export class ServicesContactModule {}
