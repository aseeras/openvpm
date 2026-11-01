ALTER TABLE "messaging_registration_events" DROP CONSTRAINT "messaging_registration_events_shape_check";--> statement-breakpoint
ALTER TABLE "sms_consent_events" DROP CONSTRAINT "sms_consent_events_actor_shape_check";--> statement-breakpoint
ALTER TABLE "sms_delivery_events" DROP CONSTRAINT "sms_delivery_events_provider_check";--> statement-breakpoint
ALTER TABLE "sms_send_attempts" DROP CONSTRAINT "sms_send_attempts_provider_check";--> statement-breakpoint
ALTER TABLE "sms_provider_events" DROP CONSTRAINT "sms_provider_events_provider_check";--> statement-breakpoint
ALTER TABLE "messaging_registration_events" ADD CONSTRAINT "messaging_registration_events_shape_check" CHECK ("messaging_registration_events"."provider" in ('telnyx', 'twilio', 'quo')
        and "messaging_registration_events"."reason_code" ~ '^[a-z0-9_]{3,64}$'
        and "messaging_registration_events"."actor_name" = btrim("messaging_registration_events"."actor_name")
        and length("messaging_registration_events"."actor_name") between 1 and 255
        and (
          ("messaging_registration_events"."actor_type" = 'clinic_user'
            and "messaging_registration_events"."actor_user_id" is not null
            and "messaging_registration_events"."actor_identity" is null)
          or ("messaging_registration_events"."actor_type" = 'platform_operator'
            and "messaging_registration_events"."actor_user_id" is null
            and length(btrim(coalesce("messaging_registration_events"."actor_identity", ''))) between 1 and 255)
          or ("messaging_registration_events"."actor_type" = 'system'
            and "messaging_registration_events"."actor_user_id" is null
            and "messaging_registration_events"."actor_identity" is null)
        )
        and ("messaging_registration_events"."provider_brand_id" is null or (
          "messaging_registration_events"."provider_brand_id" = btrim("messaging_registration_events"."provider_brand_id")
          and length("messaging_registration_events"."provider_brand_id") between 3 and 128))
        and ("messaging_registration_events"."provider_campaign_id" is null or (
          "messaging_registration_events"."provider_campaign_id" = btrim("messaging_registration_events"."provider_campaign_id")
          and length("messaging_registration_events"."provider_campaign_id") between 3 and 128))
        and ("messaging_registration_events"."messaging_profile_id" is null or (
          "messaging_registration_events"."messaging_profile_id" = btrim("messaging_registration_events"."messaging_profile_id")
          and length("messaging_registration_events"."messaging_profile_id") between 3 and 128))
        and ("messaging_registration_events"."provider_brand_status" is null
          or length("messaging_registration_events"."provider_brand_status") between 1 and 64)
        and ("messaging_registration_events"."provider_campaign_status" is null
          or length("messaging_registration_events"."provider_campaign_status") between 1 and 64)
        and (
          ("messaging_registration_events"."event_type" = 'details_saved'
            and "messaging_registration_events"."operation" = 'registration_details')
          or ("messaging_registration_events"."event_type" in (
              'provider_operation_started',
              'provider_operation_succeeded',
              'provider_operation_failed'
            ) and "messaging_registration_events"."operation" in (
              'brand_submission',
              'campaign_submission',
              'number_assignment'
            ))
          or ("messaging_registration_events"."event_type" = 'provider_state_observed'
            and "messaging_registration_events"."operation" in (
              'brand_submission',
              'campaign_submission',
              'registration_reconciliation'
            ))
          or ("messaging_registration_events"."event_type" = 'provider_ids_attached'
            and "messaging_registration_events"."operation" = 'provider_id_recovery')
          or ("messaging_registration_events"."event_type" = 'stale_lock_cleared'
            and "messaging_registration_events"."operation" = 'submission_lock_recovery')
          or ("messaging_registration_events"."event_type" = 'provider_profile_enabled'
            and "messaging_registration_events"."operation" = 'profile_activation'
            and "messaging_registration_events"."location_id" is not null
            and "messaging_registration_events"."messaging_profile_id" is not null)
          or ("messaging_registration_events"."event_type" = 'provider_profile_disabled'
            and "messaging_registration_events"."operation" = 'profile_deactivation'
            and "messaging_registration_events"."location_id" is not null
            and "messaging_registration_events"."messaging_profile_id" is not null)
          or ("messaging_registration_events"."event_type" = 'provider_profile_verified'
            and "messaging_registration_events"."operation" = 'profile_verification'
            and "messaging_registration_events"."location_id" is not null
            and "messaging_registration_events"."messaging_profile_id" is not null)
        ));--> statement-breakpoint
ALTER TABLE "sms_consent_events" ADD CONSTRAINT "sms_consent_events_actor_shape_check" CHECK ((
          "sms_consent_events"."actor_type" = 'staff'
          and "sms_consent_events"."actor_user_id" is not null
          and length(btrim(coalesce("sms_consent_events"."actor_name", ''))) > 0
          and "sms_consent_events"."provider" is null
          and "sms_consent_events"."provider_message_id" is null
        ) or (
          "sms_consent_events"."actor_type" = 'client'
          and "sms_consent_events"."actor_user_id" is null
          and "sms_consent_events"."actor_name" is null
          and "sms_consent_events"."provider" in ('telnyx', 'twilio', 'quo')
          and length(btrim(coalesce("sms_consent_events"."provider_message_id", ''))) > 0
        ) or (
          "sms_consent_events"."actor_type" = 'system'
          and "sms_consent_events"."actor_user_id" is null
          and "sms_consent_events"."actor_name" is null
          and "sms_consent_events"."provider" is null
          and "sms_consent_events"."provider_message_id" is null
        ));--> statement-breakpoint
ALTER TABLE "sms_delivery_events" ADD CONSTRAINT "sms_delivery_events_provider_check" CHECK ("sms_delivery_events"."provider" in ('telnyx', 'twilio', 'quo'));--> statement-breakpoint
ALTER TABLE "sms_send_attempts" ADD CONSTRAINT "sms_send_attempts_provider_check" CHECK ("sms_send_attempts"."provider" in ('telnyx', 'twilio', 'quo', 'console'));--> statement-breakpoint
ALTER TABLE "sms_provider_events" ADD CONSTRAINT "sms_provider_events_provider_check" CHECK ("sms_provider_events"."provider" in ('telnyx', 'twilio', 'quo'));