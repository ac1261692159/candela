import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SUBJECT_NAME_PATTERN } from '../subject-definition';

export class SubjectSourceDto {
  @IsIn(['event', 'user'])
  scope: 'event' | 'user';

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  prop: string;
}

export class CreateSubjectDto {
  @IsString()
  @Matches(SUBJECT_NAME_PATTERN, {
    message: '主体名须以小写字母开头，仅含小写字母/数字/下划线，最长 80',
  })
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  display_name: string;

  @IsObject()
  @ValidateNested()
  @Type(() => SubjectSourceDto)
  source: SubjectSourceDto;
}

export class UpdateSubjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  display_name?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SubjectSourceDto)
  source?: SubjectSourceDto;
}

export class SortSubjectsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids: string[];
}
