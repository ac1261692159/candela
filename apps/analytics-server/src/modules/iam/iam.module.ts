import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { AuthModule } from '../auth/auth.module';
import { IamService } from './iam.service';
import { AssetPolicyService } from './asset-policy.service';
import { DataScopeService } from './data-scope.service';
import { IamController } from './iam.controller';
import { IamOpsController } from './iam-ops.controller';
import { InviteController } from './invite.controller';

@Module({
  imports: [SharedModule, AuthModule],
  controllers: [IamController, IamOpsController, InviteController],
  providers: [
    IamService,
    AssetPolicyService,
    DataScopeService,
  ],
  exports: [IamService, AssetPolicyService, DataScopeService],
})
export class IamModule {}
