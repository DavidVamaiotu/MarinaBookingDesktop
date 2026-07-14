<?php
/**
 * Plugin Name: Marina Booking API
 * Description: Secure REST API bridge for Booking Calendar / Booking Calendar Pro.
 * Version: 1.0.6
 * Requires Plugins: booking
 * Author: Marina Park
 * Requires at least: 6.5
 * Requires PHP: 7.4
 * Text Domain: marina-booking-api
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Marina_Booking_API {

	const VERSION   = '1.0.6';
	const SCHEMA_VERSION = '1.0.2';
	const IDEMPOTENCY_TABLE_SUFFIX = 'marina_booking_api_idempotency';
	const NAMESPACE = 'marina-booking/v1';
	const CAPABILITY = 'manage_marina_booking_api';
	const PRICE_CACHE_PREFIX = 'mbapi_price_quote_v1_';
	const PRICE_CACHE_TTL_FAST = 60;
	const PRICE_CACHE_TTL_FULL = 30;

	/**
	 * Boot the plugin.
	 *
	 * @return void
	 */
	public static function init() {
		add_action( 'plugins_loaded', array( __CLASS__, 'maybe_upgrade_schema' ), 20 );
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		add_action( 'admin_notices', array( __CLASS__, 'dependency_notice' ) );
		add_filter( 'rest_post_dispatch', array( __CLASS__, 'add_security_headers' ), 10, 3 );
	}

	/**
	 * Grant the API capability to administrators only. Other roles must be granted
	 * this capability deliberately; do not grant it to subscribers or editors.
	 *
	 * @return void
	 */
	public static function activate() {
		$administrator = get_role( 'administrator' );
		if ( $administrator ) {
			$administrator->add_cap( self::CAPABILITY );
		}

		// A dedicated role keeps the integration account separate from administrator access.
		$integration_role = get_role( 'marina_booking_api' );
		if ( ! $integration_role ) {
			$integration_role = add_role(
				'marina_booking_api',
				'Marina Booking API',
				array(
					'read'           => true,
					self::CAPABILITY => true,
				)
			);
		}
		if ( $integration_role ) {
			$integration_role->add_cap( self::CAPABILITY );
		}

		self::create_or_upgrade_schema();
	}

	/**
	 * Create the custom idempotency table after a plugin update. This is run before
	 * REST routes are registered, so remote clients never see a partially upgraded API.
	 *
	 * @return void
	 */
	public static function maybe_upgrade_schema() {
		if ( self::SCHEMA_VERSION !== get_option( 'marina_booking_api_schema_version' ) ) {
			self::create_or_upgrade_schema();
		}
	}

	/**
	 * Store idempotency records independently of Booking Calendar vendor tables.
	 * The unique external_id hash makes one external create command globally unique.
	 *
	 * @return void
	 */
	private static function create_or_upgrade_schema() {
		global $wpdb;
		$table           = self::idempotency_table();
		$charset_collate = $wpdb->get_charset_collate();

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$sql = "CREATE TABLE {$table} (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			user_id bigint(20) unsigned NOT NULL,
			route_hash char(64) NOT NULL,
			key_hash char(64) NOT NULL,
			request_hash char(64) NOT NULL,
			external_id varchar(120) DEFAULT NULL,
			external_id_hash char(64) DEFAULT NULL,
			state varchar(20) NOT NULL,
			response_code smallint(5) unsigned DEFAULT NULL,
			response_body longtext NULL,
			booking_id bigint(20) unsigned DEFAULT NULL,
			created_at datetime NOT NULL,
			updated_at datetime NOT NULL,
			PRIMARY KEY  (id),
			UNIQUE KEY marina_idempotency_unique (user_id,route_hash,key_hash),
			UNIQUE KEY marina_external_id_unique (external_id_hash),
			KEY marina_state_updated (state,updated_at),
			KEY marina_booking_id (booking_id)
		) {$charset_collate};";
		dbDelta( $sql );
		update_option( 'marina_booking_api_schema_version', self::SCHEMA_VERSION, false );
	}

	/**
	 * @return string
	 */
	private static function idempotency_table() {
		global $wpdb;
		return $wpdb->prefix . self::IDEMPOTENCY_TABLE_SUFFIX;
	}

	/**
	 * Show a clear admin warning if the booking plugin is unavailable.
	 *
	 * @return void
	 */
	public static function dependency_notice() {
		if ( ! current_user_can( 'activate_plugins' ) || self::booking_calendar_ready() ) {
			return;
		}

		echo '<div class="notice notice-error"><p><strong>Marina Booking API:</strong> Booking Calendar is not active or its developer API could not be loaded. Activate the <code>booking</code> plugin first.</p></div>';
	}

	/**
	 * Register every route in one, private REST namespace.
	 *
	 * @return void
	 */
	public static function register_routes() {
		register_rest_route(
			self::NAMESPACE,
			'/resources',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'get_resources' ),
				'permission_callback' => array( __CLASS__, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/availability',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'check_availability' ),
				'permission_callback' => array( __CLASS__, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/prices/calculate',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'calculate_price' ),
				'permission_callback' => array( __CLASS__, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/bookings',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => array( __CLASS__, 'list_bookings' ),
					'permission_callback' => array( __CLASS__, 'permission_check' ),
				),
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => array( __CLASS__, 'create_booking' ),
					'permission_callback' => array( __CLASS__, 'permission_check' ),
				),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/bookings/by-external-id/(?P<external_id>[A-Za-z0-9._:-]{8,120})',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'get_booking_by_external_id' ),
				'permission_callback' => array( __CLASS__, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/bookings/(?P<id>\\d+)',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => array( __CLASS__, 'get_booking' ),
					'permission_callback' => array( __CLASS__, 'permission_check' ),
				),
				array(
					'methods'             => WP_REST_Server::EDITABLE,
					'callback'            => array( __CLASS__, 'update_booking' ),
					'permission_callback' => array( __CLASS__, 'permission_check' ),
				),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/bookings/(?P<id>\\d+)/status',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'set_booking_status' ),
				'permission_callback' => array( __CLASS__, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/bookings/(?P<id>\\d+)/note',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'set_booking_note' ),
				'permission_callback' => array( __CLASS__, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/bookings/(?P<id>\\d+)/trash',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'set_booking_trash' ),
				'permission_callback' => array( __CLASS__, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/bookings/(?P<id>\\d+)/payment',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'get_booking_payment' ),
				'permission_callback' => array( __CLASS__, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/bookings/(?P<id>\\d+)/deposit',
			array(
				'methods'             => WP_REST_Server::EDITABLE,
				'callback'            => array( __CLASS__, 'set_booking_deposit' ),
				'permission_callback' => array( __CLASS__, 'permission_check' ),
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/bookings/(?P<id>\\d+)/payment-request',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'send_booking_payment_request' ),
				'permission_callback' => array( __CLASS__, 'permission_check' ),
			)
		);
	}

	/**
	 * Require HTTPS, an authenticated WordPress REST request, the dedicated
	 * capability, and a conservative per-user rate limit.
	 *
	 * Cookie authentication must carry the normal wp_rest nonce. For remote
	 * integrations use a dedicated WordPress Application Password over HTTPS.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return true|WP_Error
	 */
	public static function permission_check( WP_REST_Request $request ) {
		if ( ! self::booking_calendar_ready() ) {
			return new WP_Error( 'marina_booking_api_dependency_missing', 'Booking Calendar developer API is unavailable.', array( 'status' => 503 ) );
		}

		if ( self::https_required() && ! is_ssl() ) {
			return new WP_Error( 'marina_booking_api_https_required', 'HTTPS is required for this API.', array( 'status' => 403 ) );
		}

		if ( ! is_user_logged_in() || ! current_user_can( self::CAPABILITY ) ) {
			return new WP_Error( 'marina_booking_api_forbidden', 'You are not allowed to use this API.', array( 'status' => 403 ) );
		}

		// WordPress validates cookie REST nonces before callbacks, but this explicit
		// check prevents a logged-in browser cookie from becoming a CSRF credential.
		$app_password_uuid = function_exists( 'rest_get_authenticated_app_password' ) ? rest_get_authenticated_app_password() : null;
		if ( empty( $app_password_uuid ) ) {
			$nonce = $request->get_header( 'X-WP-Nonce' );
			if ( empty( $nonce ) ) {
				$nonce = $request->get_param( '_wpnonce' );
			}
			if ( ! wp_verify_nonce( $nonce, 'wp_rest' ) ) {
				return new WP_Error( 'marina_booking_api_nonce_required', 'A valid REST nonce or an Application Password is required.', array( 'status' => 403 ) );
			}
		}

		return self::enforce_rate_limit( $request );
	}

	/**
	 * Filter hook for local development only. Production default is true.
	 *
	 * @return bool
	 */
	private static function https_required() {
		return (bool) apply_filters( 'marina_booking_api_require_https', true );
	}

	/**
	 * Rate limit by user, route and time window. This is a safety valve, not an
	 * authentication mechanism.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return true|WP_Error
	 */
	private static function enforce_rate_limit( WP_REST_Request $request ) {
		$method   = strtoupper( $request->get_method() );
		$is_write = in_array( $method, array( 'POST', 'PUT', 'PATCH', 'DELETE' ), true );
		// Price previews are POST requests because their input can be substantial, but they do not mutate data.
		$is_price_preview = ( '/' . self::NAMESPACE . '/prices/calculate' === untrailingslashit( (string) $request->get_route() ) );
		$limit    = ( $is_write && ! $is_price_preview ) ? 60 : 300;
		$window   = 300;
		$bucket   = (int) floor( time() / $window );
		$key      = 'mbapi_rl_' . md5( get_current_user_id() . '|' . $request->get_route() . '|' . $bucket );
		$count    = (int) get_transient( $key );

		if ( $count >= $limit ) {
			return new WP_Error( 'marina_booking_api_rate_limited', 'Too many requests. Please try again shortly.', array( 'status' => 429 ) );
		}

		set_transient( $key, $count + 1, $window );
		return true;
	}

	/**
	 * Make all API responses private and non-cacheable because booking responses
	 * can include personal data.
	 *
	 * @param WP_REST_Response|WP_HTTP_Response $response Response object.
	 * @param WP_REST_Server                     $server   REST server.
	 * @param WP_REST_Request                    $request  Request.
	 * @return WP_REST_Response|WP_HTTP_Response
	 */
	public static function add_security_headers( $response, $server, $request ) {
		if ( 0 !== strpos( $request->get_route(), '/' . self::NAMESPACE . '/' ) ) {
			return $response;
		}

		$response->header( 'Cache-Control', 'no-store, private, max-age=0' );
		$response->header( 'Pragma', 'no-cache' );
		$response->header( 'X-Content-Type-Options', 'nosniff' );
		return $response;
	}

	/**
	 * Retrieve booking resources without exposing unneeded internal metadata.
	 *
	 * @return WP_REST_Response|WP_Error
	 */
	public static function get_resources() {
		global $wpdb;

		$table = $wpdb->prefix . 'bookingtypes';
		$rows  = $wpdb->get_results( "SELECT booking_type_id, title, parent, visitors, cost, default_form, prioritet FROM {$table} ORDER BY prioritet ASC, booking_type_id ASC", ARRAY_A ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching

		$resources = array();
		foreach ( (array) $rows as $row ) {
			$resources[] = array(
				'id'           => (int) $row['booking_type_id'],
				'title'        => wp_strip_all_tags( $row['title'] ),
				'parent_id'    => (int) $row['parent'],
				'capacity'     => (int) $row['visitors'],
				'base_cost'    => is_numeric( $row['cost'] ) ? (float) $row['cost'] : null,
				'default_form' => sanitize_key( $row['default_form'] ),
			);
		}

		return self::response( array( 'resources' => $resources ) );
	}

	/**
	 * Check whether requested dates/times are unavailable.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function check_availability( WP_REST_Request $request ) {
		$resource_id = self::validated_resource_id( $request->get_param( 'resource_id' ) );
		if ( is_wp_error( $resource_id ) ) {
			return $resource_id;
		}

		$dates = self::normalize_dates( $request->get_param( 'dates' ) );
		if ( is_wp_error( $dates ) ) {
			return $dates;
		}

		$exclude_booking_id = 0;
		$exclude_value      = $request->get_param( 'exclude_booking_id' );
		if ( null !== $exclude_value && '' !== $exclude_value ) {
			$exclude_booking_id = absint( $exclude_value );
			if ( ! is_numeric( $exclude_value ) || (float) $exclude_value !== (float) $exclude_booking_id || $exclude_booking_id < 1 ) {
				return new WP_Error( 'marina_booking_api_invalid_exclude_booking_id', 'exclude_booking_id must be a positive integer.', array( 'status' => 422 ) );
			}
			$excluded_booking = self::raw_booking( $exclude_booking_id );
			if ( is_wp_error( $excluded_booking ) ) {
				return $excluded_booking;
			}
		}

		// wpbc_api_is_dates_booked() expects a time component for its first and
		// last values, even for all-day bookings. Keep create/edit inputs ergonomic
		// while supplying the exact format the upstream helper requires.
		$is_booked = self::dates_are_booked( $dates, $resource_id, $exclude_booking_id );
		if ( is_wp_error( $is_booked ) ) {
			return $is_booked;
		}
		return self::response(
			array(
				'resource_id'        => $resource_id,
				'dates'              => $dates,
				'exclude_booking_id' => $exclude_booking_id ?: null,
				'available'          => ! $is_booked,
			)
		);
	}

	/**
	 * Run Booking Calendar's native availability lookup, excluding the reservation
	 * currently being edited when the client supplies its server booking ID.
	 *
	 * @param array $dates Validated ISO dates or datetimes.
	 * @param int   $resource_id Booking resource ID.
	 * @param int   $exclude_booking_id Existing booking ID to ignore.
	 * @return bool|WP_Error
	 */
	private static function dates_are_booked( $dates, $resource_id, $exclude_booking_id = 0 ) {
		$booking_dates = self::dates_for_availability( $dates );
		if ( ! $exclude_booking_id ) {
			return wpbc_api_is_dates_booked( $booking_dates, $resource_id, array( 'is_use_booking_recurrent_time' => false ) );
		}
		if ( ! function_exists( 'wpbc__where_to_save_booking' ) || ! function_exists( 'wpbc_transform__24_hours_his__in__seconds' ) ) {
			return new WP_Error( 'marina_booking_api_availability_unavailable', 'Booking Calendar cannot perform an edit-safe availability check.', array( 'status' => 503 ) );
		}

		$dates_only = array_map(
			function( $value ) {
				$parts = explode( ' ', $value );
				return $parts[0];
			},
			$booking_dates
		);
		$first_parts = explode( ' ', $booking_dates[0] );
		$last_parts  = explode( ' ', $booking_dates[ count( $booking_dates ) - 1 ] );
		$times       = array(
			wpbc_transform__24_hours_his__in__seconds( $first_parts[1] ),
			wpbc_transform__24_hours_his__in__seconds( $last_parts[1] ),
		);
		$request_uri = isset( $_SERVER['REQUEST_URI'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '';
		$result      = wpbc__where_to_save_booking(
			array(
				'resource_id'                  => $resource_id,
				'skip_booking_id'              => $exclude_booking_id,
				'dates_only_sql_arr'           => $dates_only,
				'time_as_seconds_arr'           => $times,
				'how_many_items_to_book'        => 1,
				'request_uri'                   => $request_uri,
				'as_single_resource'            => true,
				'is_use_booking_recurrent_time' => false,
			)
		);
		if ( ! is_array( $result ) || ! isset( $result['result'] ) ) {
			return new WP_Error( 'marina_booking_api_invalid_availability_result', 'Booking Calendar returned an invalid availability result.', array( 'status' => 502 ) );
		}
		return 'ok' !== $result['result'];
	}


	/**
	 * Calculate a price through the installed Booking Calendar Business Medium+
	 * engine. This is deliberately read-only: it neither creates nor changes a
	 * booking, and it does not require an Idempotency-Key.
	 *
	 * It mirrors the vendor AJAX cost workflow for one primary booking resource:
	 * native daily/seasonal rates, duration discounts, advanced form costs,
	 * coupon discounts, deposits and balance. Additional-calendar/multi-resource
	 * forms are rejected rather than returning a misleading partial total.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function calculate_price( WP_REST_Request $request ) {
		if ( ! self::price_engine_ready() ) {
			return new WP_Error(
				'marina_booking_api_price_engine_unavailable',
				'The installed Booking Calendar edition does not expose its native price engine.',
				array( 'status' => 501 )
			);
		}

		$payload     = self::payload( $request );
		$mode        = self::normalize_price_mode( isset( $payload['mode'] ) ? $payload['mode'] : 'full' );
		if ( is_wp_error( $mode ) ) {
			return $mode;
		}
		$resource_id = self::validated_resource_id( isset( $payload['resource_id'] ) ? $payload['resource_id'] : 0 );
		if ( is_wp_error( $resource_id ) ) {
			return $resource_id;
		}

		$dates = self::normalize_price_dates( isset( $payload['dates'] ) ? $payload['dates'] : array() );
		if ( is_wp_error( $dates ) ) {
			return $dates;
		}

		$form_data = self::normalize_form_data( isset( $payload['form_data'] ) ? $payload['form_data'] : array(), true );
		if ( is_wp_error( $form_data ) ) {
			return $form_data;
		}
		if ( array_key_exists( 'additional_calendars', $form_data ) ) {
			return new WP_Error(
				'marina_booking_api_additional_calendars_unsupported',
				'Price calculation for additional calendars is not available through this endpoint. Calculate each resource separately.',
				array( 'status' => 422 )
			);
		}

		$booking_form_type = '';
		if ( isset( $payload['booking_form_type'] ) && '' !== (string) $payload['booking_form_type'] ) {
			$booking_form_type = sanitize_key( (string) $payload['booking_form_type'] );
			if ( '' === $booking_form_type || strlen( $booking_form_type ) > 80 ) {
				return new WP_Error( 'marina_booking_api_invalid_booking_form_type', 'booking_form_type is invalid.', array( 'status' => 422 ) );
			}
		}

		// This is a private, server-side cache. The HTTP response remains no-store
		// because it can contain customer-dependent form pricing.
		$cache_ttl = self::price_cache_ttl( $mode );
		$cache_key = self::price_cache_key( $resource_id, $dates, $form_data, $booking_form_type, $mode );
		if ( $cache_ttl > 0 ) {
			$cached_quote = get_transient( $cache_key );
			if ( is_array( $cached_quote ) && isset( $cached_quote['quote'] ) && is_array( $cached_quote['quote'] ) ) {
				return self::price_response( $cached_quote['quote'], $mode, 'HIT' );
			}
		}

		$serialized_form = self::serialize_form_data_for_booking_calendar( $form_data, $resource_id );
		if ( is_wp_error( $serialized_form ) ) {
			return $serialized_form;
		}
		if ( '' !== $booking_form_type ) {
			if ( ! class_exists( 'WPBC_FE_Custom_Form_Helper' ) || ! method_exists( 'WPBC_FE_Custom_Form_Helper', 'maybe_implement__custom_form_name__in__form_data' ) ) {
				return new WP_Error(
					'marina_booking_api_custom_form_pricing_unavailable',
					'Native custom-form price calculation is unavailable in this Booking Calendar installation.',
					array( 'status' => 501 )
				);
			}
			$serialized_form = WPBC_FE_Custom_Form_Helper::maybe_implement__custom_form_name__in__form_data( $serialized_form, $booking_form_type, $resource_id );
		}

		// The vendor price engine reads this field for some advanced cost rules.
		$had_form_type      = array_key_exists( 'booking_form_type', $_POST );
		$previous_form_type = $had_form_type ? $_POST['booking_form_type'] : null;
		$_POST['booking_form_type'] = $booking_form_type;

		try {
			$price = self::calculate_native_price( $resource_id, $dates, $serialized_form, $mode );
		} catch ( Throwable $exception ) {
			error_log( 'Marina Booking API: native price calculation ended unexpectedly.' );
			return new WP_Error(
				'marina_booking_api_price_calculation_failed',
				'The server could not calculate this price. Check the Booking Calendar price configuration.',
				array( 'status' => 500 )
			);
		} finally {
			if ( $had_form_type ) {
				$_POST['booking_form_type'] = $previous_form_type;
			} else {
				unset( $_POST['booking_form_type'] );
			}
		}

		if ( is_wp_error( $price ) ) {
			return $price;
		}

		if ( $cache_ttl > 0 ) {
			set_transient(
				$cache_key,
				array(
					'quote'      => $price,
					'cached_at'  => time(),
					'cache_ttl'  => $cache_ttl,
				),
				$cache_ttl
			);
		}

		return self::price_response( $price, $mode, ( $cache_ttl > 0 ) ? 'MISS' : 'BYPASS' );
	}

	/**
	 * Price mode is deliberately explicit. Full remains the default to preserve
	 * the v1.0.3 endpoint contract for existing clients.
	 *
	 * @param mixed $mode Requested mode.
	 * @return string|WP_Error
	 */
	private static function normalize_price_mode( $mode ) {
		$mode = sanitize_key( (string) $mode );
		if ( '' === $mode ) {
			$mode = 'full';
		}
		if ( ! in_array( $mode, array( 'fast', 'full' ), true ) ) {
			return new WP_Error( 'marina_booking_api_invalid_price_mode', 'mode must be either fast or full.', array( 'status' => 422 ) );
		}
		return $mode;
	}

	/**
	 * Keep price quotes short-lived because third-party pricing filters can depend
	 * on time, configuration, or the authenticated API user. A filter allows a
	 * site owner to disable cache (0) or reduce TTL without editing this plugin.
	 *
	 * @param string $mode Price mode.
	 * @return int
	 */
	private static function price_cache_ttl( $mode ) {
		$default = ( 'fast' === $mode ) ? self::PRICE_CACHE_TTL_FAST : self::PRICE_CACHE_TTL_FULL;
		$ttl     = (int) apply_filters( 'marina_booking_api_price_cache_ttl', $default, $mode );
		return max( 0, min( 120, $ttl ) );
	}

	/**
	 * Build a private key from only normalized price inputs. The current API user,
	 * site and locale are included so a quote is never shared across contexts.
	 *
	 * @param int    $resource_id Resource ID.
	 * @param array  $dates       Normalized ISO dates.
	 * @param array  $form_data   Normalized form data.
	 * @param string $form_type   Booking Calendar form name.
	 * @param string $mode        Price mode.
	 * @return string
	 */
	private static function price_cache_key( $resource_id, $dates, $form_data, $form_type, $mode ) {
		$input = array(
			'plugin_version'  => self::VERSION,
			'site_id'         => function_exists( 'get_current_blog_id' ) ? get_current_blog_id() : 1,
			'user_id'         => get_current_user_id(),
			'locale'          => get_locale(),
			'resource_id'     => (int) $resource_id,
			'dates'           => array_values( $dates ),
			'form_data'       => self::canonicalize_price_cache_value( $form_data ),
			'booking_form_type' => (string) $form_type,
			'mode'            => (string) $mode,
		);
		$json = wp_json_encode( $input, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( false === $json ) {
			$json = serialize( $input ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.serialize_serialize
		}
		return self::PRICE_CACHE_PREFIX . hash( 'sha256', $json );
	}

	/**
	 * Canonicalize associative form-field order for stable cache keys while
	 * preserving ordered numeric arrays.
	 *
	 * @param mixed $value Value to canonicalize.
	 * @return mixed
	 */
	private static function canonicalize_price_cache_value( $value ) {
		if ( ! is_array( $value ) ) {
			return $value;
		}
		$is_list = empty( $value ) || array_keys( $value ) === range( 0, count( $value ) - 1 );
		if ( ! $is_list ) {
			ksort( $value, SORT_STRING );
		}
		foreach ( $value as $key => $item ) {
			$value[ $key ] = self::canonicalize_price_cache_value( $item );
		}
		return $value;
	}

	/**
	 * @param array  $price Quote payload.
	 * @param string $mode Price mode.
	 * @param string $cache_state HIT, MISS, or BYPASS.
	 * @return WP_REST_Response
	 */
	private static function price_response( $price, $mode, $cache_state ) {
		$response = self::response( $price );
		$response->header( 'X-Marina-Price-Mode', strtoupper( $mode ) );
		$response->header( 'X-Marina-Price-Cache', $cache_state );
		return $response;
	}

	/**
	 * Perform the same primary-resource arithmetic used by Booking Calendar's
	 * wpdev_ajax_show_cost handler, but return JSON instead of JavaScript.
	 *
	 * @param int    $resource_id Booking resource ID.
	 * @param array  $dates       Validated ISO dates.
	 * @param string $form_data   Legacy Booking Calendar serialized form fields.
	 * @param string $mode        fast or full.
	 * @return array|WP_Error
	 */
	private static function calculate_native_price( $resource_id, $dates, $form_data, $mode ) {
		$dates_csv = self::dates_to_booking_calendar_csv( $dates );
		$diff      = wpbc_get_dates_in_diff_formats( $dates_csv, $resource_id, $form_data );
		if ( ! is_array( $diff ) || empty( $diff['string'] ) || empty( $diff['array'] ) ) {
			return new WP_Error( 'marina_booking_api_price_dates_unusable', 'Booking Calendar could not interpret the supplied dates for price calculation.', array( 'status' => 422 ) );
		}

		// Mirror Booking Calendar's checkout rule exactly: the final selected day is
		// checkout-only and must not be charged when this site option is enabled.
		if ( function_exists( 'get_bk_option' ) && 'On' === get_bk_option( 'booking_last_checkout_day_available' ) ) {
			$chargeable = (array) $diff['array'];
			array_pop( $chargeable );
			if ( empty( $chargeable ) ) {
				return new WP_Error(
					'marina_booking_api_price_requires_checkout_range',
					'At least two selected dates are required when the last checkout day is not chargeable.',
					array( 'status' => 422 )
				);
			}
			$chargeable_csv = array();
			foreach ( $chargeable as $date ) {
				$chargeable_csv[] = gmdate( 'd.m.Y', strtotime( $date ) );
			}
			$diff = wpbc_get_dates_in_diff_formats( implode( ', ', $chargeable_csv ), $resource_id, $form_data );
			if ( ! is_array( $diff ) || empty( $diff['string'] ) || empty( $diff['array'] ) ) {
				return new WP_Error( 'marina_booking_api_price_dates_unusable', 'Booking Calendar could not interpret the chargeable dates.', array( 'status' => 422 ) );
			}
		}

		$start_time = isset( $diff['start_time'] ) && is_array( $diff['start_time'] ) ? $diff['start_time'] : array( '00', '00', '01' );
		$end_time   = isset( $diff['end_time'] ) && is_array( $diff['end_time'] ) ? $diff['end_time'] : array( '00', '00', '02' );
		$date_string = (string) $diff['string'];
		$date_list   = (array) $diff['array'];
		$times       = array( $start_time, $end_time );
		$is_full     = ( 'full' === $mode );

		// Both modes use Booking Calendar's native total. Fast deliberately avoids
		// all website-preview-only work after this point.
		$total = (float) wpbc_calc__booking_cost(
			array(
				'resource_id'           => $resource_id,
				'str_dates__dd_mm_yyyy' => $date_string,
				'times_array'           => $times,
				'form_data'             => $form_data,
			)
		);

		$deposit_uses_original = function_exists( 'get_bk_option' ) && 'On' === get_bk_option( 'booking_calc_deposit_on_original_cost_only' );
		$needs_original        = $is_full || $deposit_uses_original;
		$original              = null;
		if ( $needs_original ) {
			$original = (float) wpbc_calc__booking_cost(
				array(
					'resource_id'           => $resource_id,
					'str_dates__dd_mm_yyyy' => $date_string,
					'times_array'           => $times,
					'form_data'             => $form_data,
					'is_discount_calculate' => false,
					'is_only_original_cost' => true,
				)
			);
		}

		$advanced_hints = array();
		if ( $is_full && function_exists( 'apply_bk_filter' ) ) {
			$maybe_hints   = apply_bk_filter( 'advanced_cost_apply', $original, $form_data, $resource_id, explode( ',', $date_string ), true );
			$advanced_hints = self::numeric_cost_hints( $maybe_hints );
		}

		$coupon_discount    = 0.0;
		$coupon_description = '';
		if ( function_exists( 'apply_bk_filter' ) ) {
			$coupon_discount = (float) apply_bk_filter( 'wpbc_get_coupon_code_discount_value', '', $resource_id, $date_string, $times, $form_data );
			if ( $is_full ) {
				$coupon_description = wp_strip_all_tags( (string) apply_bk_filter( 'wpdev_get_additional_description_about_coupons', '', $resource_id, $date_string, $times, $form_data ) );
			}
		}

		$deposit = $total;
		if ( function_exists( 'apply_bk_filter' ) ) {
			if ( $deposit_uses_original ) {
				$deposit = (float) apply_bk_filter( 'wpbc_calc__deposit_cost__if_enabled', $original, $resource_id, $date_string );
				if ( $deposit === $original ) {
					$deposit = $total;
				}
			} else {
				$deposit = (float) apply_bk_filter( 'wpbc_calc__deposit_cost__if_enabled', $total, $resource_id, $date_string );
			}
		}
		$balance = $total - $deposit;
		if ( $balance < 0 ) {
			$deposit = $total;
			$balance = 0.0;
		}

		$days   = count( $date_list );
		$nights = ( $days > 1 ) ? ( $days - 1 ) : $days;
		$common = array(
			'mode'                        => $mode,
			'resource_id'                 => $resource_id,
			'input_dates'                 => $dates,
			'chargeable_dates'            => array_values( $date_list ),
			'days'                        => $days,
			'nights'                      => $nights,
			'last_checkout_day_excluded'  => ( function_exists( 'get_bk_option' ) && 'On' === get_bk_option( 'booking_last_checkout_day_available' ) ),
			'coupon_discount'             => $coupon_discount,
			'total'                       => $total,
			'deposit'                     => $deposit,
			'balance'                     => $balance,
		);

		if ( ! $is_full ) {
			$common['formatted'] = array(
				'coupon_discount' => self::format_booking_cost( $coupon_discount, $resource_id ),
				'total'           => self::format_booking_cost( $total, $resource_id ),
				'deposit'         => self::format_booking_cost( $deposit, $resource_id ),
				'balance'         => self::format_booking_cost( $balance, $resource_id ),
			);
			return $common;
		}

		$additional = max( 0.0, $total - $original );
		$resource   = function_exists( 'get_booking_resource_attr' ) ? get_booking_resource_attr( $resource_id ) : false;
		$base_cost  = ( is_object( $resource ) && isset( $resource->cost ) && is_numeric( $resource->cost ) ) ? (float) $resource->cost : null;

		return array_merge(
			$common,
			array(
				'base_cost'            => $base_cost,
				'original_cost'        => $original,
				'additional_cost'      => $additional,
				'advanced_cost_hints'  => $advanced_hints,
				'coupon_description'   => self::sanitize_text( $coupon_description, 1000 ),
				'formatted'            => array(
					'original_cost'      => self::format_booking_cost( $original, $resource_id ),
					'additional_cost'    => self::format_booking_cost( $additional, $resource_id ),
					'coupon_discount'    => self::format_booking_cost( $coupon_discount, $resource_id ),
					'total'              => self::format_booking_cost( $total, $resource_id ),
					'deposit'            => self::format_booking_cost( $deposit, $resource_id ),
					'balance'            => self::format_booking_cost( $balance, $resource_id ),
				),
			)
		);
	}

	/**
	 * Booking Calendar's developer API serializes submitted fields as
	 * type^fieldName+resourceId^value~... . Recreate that one format here so the
	 * same native rules see the same inputs.
	 *
	 * @param array $form_data Validated normalized form data.
	 * @param int   $resource_id Booking resource ID.
	 * @return string|WP_Error
	 */
	private static function serialize_form_data_for_booking_calendar( $form_data, $resource_id ) {
		$fields = array();
		foreach ( $form_data as $field_name => $field ) {
			if ( ! is_array( $field ) || ! isset( $field['type'] ) || ! array_key_exists( 'value', $field ) ) {
				return new WP_Error( 'marina_booking_api_invalid_form_data', 'form_data could not be serialized.', array( 'status' => 422 ) );
			}
			$type = str_replace( array( '^', '~' ), array( 'curret', 'tilde' ), (string) $field['type'] );
			$name = str_replace( array( '^', '~' ), array( 'curret', 'tilde' ), (string) $field_name . $resource_id );
			$value = str_replace( array( '^', '~' ), array( 'curret', 'tilde' ), (string) $field['value'] );
			$fields[] = $type . '^' . $name . '^' . $value;
		}
		return implode( '~', $fields );
	}

	/**
	 * Price calculations use date-only selections. For time-slot pricing, pass
	 * the same native time/range field in form_data that Booking Calendar uses.
	 *
	 * @param mixed $dates Date list.
	 * @return array|WP_Error
	 */
	private static function normalize_price_dates( $dates ) {
		$dates = self::normalize_dates( $dates );
		if ( is_wp_error( $dates ) ) {
			return $dates;
		}
		foreach ( $dates as $date ) {
			if ( 10 !== strlen( $date ) ) {
				return new WP_Error(
					'marina_booking_api_price_datetime_not_supported',
					'For price calculations, dates must use YYYY-MM-DD. Time-slot pricing must be supplied through Booking Calendar form fields.',
					array( 'status' => 422 )
				);
			}
		}
		usort( $dates, function( $left, $right ) {
			return strcmp( $left, $right );
		} );
		return $dates;
	}

	/**
	 * @param array $dates ISO date-only strings.
	 * @return string
	 */
	private static function dates_to_booking_calendar_csv( $dates ) {
		$output = array();
		foreach ( $dates as $date ) {
			$output[] = DateTimeImmutable::createFromFormat( '!Y-m-d', $date, wp_timezone() )->format( 'd.m.Y' );
		}
		return implode( ', ', $output );
	}

	/**
	 * Keep only scalar numeric advanced-cost hints, avoiding an accidental leak of
	 * arbitrary internal objects from third-party pricing add-ons.
	 *
	 * @param mixed $hints Hints returned by Booking Calendar.
	 * @return array
	 */
	private static function numeric_cost_hints( $hints ) {
		if ( ! is_array( $hints ) ) {
			return array();
		}
		$output = array();
		foreach ( $hints as $key => $value ) {
			if ( is_scalar( $value ) && is_numeric( $value ) ) {
				$output[ sanitize_key( (string) $key ) ] = (float) $value;
			}
		}
		return $output;
	}

	/**
	 * @param float $amount Numeric amount.
	 * @param int   $resource_id Booking resource ID.
	 * @return string
	 */
	private static function format_booking_cost( $amount, $resource_id ) {
		if ( function_exists( 'wpbc_get_cost_with_currency_for_user' ) ) {
			return trim( wp_strip_all_tags( wpbc_get_cost_with_currency_for_user( $amount, $resource_id ) ) );
		}
		return number_format_i18n( (float) $amount, 2 );
	}

	/**
	 * @return bool
	 */
	private static function price_engine_ready() {
		return function_exists( 'wpbc_calc__booking_cost' )
			&& function_exists( 'wpbc_get_dates_in_diff_formats' )
			&& function_exists( 'wpbc_get_cost_with_currency_for_user' );
	}

	/**
	 * Create a reservation through Booking Calendar's own supported developer API.
	 * The plugin still performs its final availability check, avoiding a simple
	 * check-then-create race condition.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function create_booking( WP_REST_Request $request ) {
		return self::execute_idempotent(
			$request,
			function() use ( $request ) {
				return self::create_booking_operation( $request );
			},
			true
		);
	}

	/**
	 * Internal operation invoked only after an idempotency key has been reserved.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function create_booking_operation( WP_REST_Request $request ) {
		$payload = self::payload( $request );
		$external_id = self::validated_external_id( isset( $payload['external_id'] ) ? $payload['external_id'] : '' );
		if ( is_wp_error( $external_id ) ) {
			return $external_id;
		}
		$payload['external_id'] = $external_id;

		$existing_by_external_id = self::find_booking_id_by_external_id( $external_id );
		if ( is_wp_error( $existing_by_external_id ) ) {
			return $existing_by_external_id;
		}
		if ( $existing_by_external_id ) {
			return self::response( array( 'booking_id' => $existing_by_external_id, 'reconciled' => true ), 200 );
		}
		$resource_id = self::validated_resource_id( isset( $payload['resource_id'] ) ? $payload['resource_id'] : 0 );
		if ( is_wp_error( $resource_id ) ) {
			return $resource_id;
		}

		$dates = self::normalize_dates( isset( $payload['dates'] ) ? $payload['dates'] : array() );
		if ( is_wp_error( $dates ) ) {
			return $dates;
		}

		$form_data = self::normalize_form_data( isset( $payload['form_data'] ) ? $payload['form_data'] : array() );
		if ( is_wp_error( $form_data ) ) {
			return $form_data;
		}
		$form_data = self::form_data_with_date_times( $form_data, $dates );

		$params = self::booking_save_params( $payload );
		if ( is_wp_error( $params ) ) {
			return $params;
		}
		$booking_id = wpbc_api_booking_add_new( $dates, $form_data, $resource_id, $params );
		if ( is_wp_error( $booking_id ) ) {
			return new WP_Error( 'marina_booking_api_create_failed', $booking_id->get_error_message(), array( 'status' => 422 ) );
		}

		self::audit( 'booking_created', (int) $booking_id );
		return self::response( array( 'booking_id' => (int) $booking_id ), 201 );
	}

	/**
	 * Replace the dates/form data of an existing booking using the Booking Calendar
	 * developer API's documented edit mode.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function update_booking( WP_REST_Request $request ) {
		return self::execute_idempotent(
			$request,
			function() use ( $request ) {
				return self::update_booking_operation( $request );
			},
			false
		);
	}

	/**
	 * Internal operation invoked only after an idempotency key has been reserved.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function update_booking_operation( WP_REST_Request $request ) {
		$booking_id = absint( $request['id'] );
		$existing   = self::raw_booking( $booking_id );
		if ( is_wp_error( $existing ) ) {
			return $existing;
		}

		$payload = self::payload( $request );
		$existing_external_id = isset( $existing['sync_gid'] ) ? (string) $existing['sync_gid'] : '';
		if ( array_key_exists( 'external_id', $payload ) ) {
			$requested_external_id = self::validated_external_id( $payload['external_id'] );
			if ( is_wp_error( $requested_external_id ) ) {
				return $requested_external_id;
			}
			if ( ! hash_equals( $existing_external_id, $requested_external_id ) ) {
				return new WP_Error( 'marina_booking_api_external_id_immutable', 'external_id is immutable after creation and cannot be added or changed during an edit.', array( 'status' => 422 ) );
			}
		}

		$existing_resource_id = (int) $existing['booking_type'];
		$resource_value = isset( $payload['resource_id'] ) ? $payload['resource_id'] : $existing_resource_id;
		$resource_id = self::validated_resource_id( $resource_value );
		if ( is_wp_error( $resource_id ) ) {
			return $resource_id;
		}
		$is_resource_move = $resource_id !== $existing_resource_id;
		if ( $is_resource_move && ! function_exists( 'wpbc__sql__change_booking_resource_for_booking' ) ) {
			return new WP_Error( 'marina_booking_api_resource_move_unavailable', 'The installed Booking Calendar version cannot move bookings between resources.', array( 'status' => 503 ) );
		}

		$dates = self::normalize_dates( isset( $payload['dates'] ) ? $payload['dates'] : array() );
		if ( is_wp_error( $dates ) ) {
			return $dates;
		}

		$form_data = self::normalize_form_data( isset( $payload['form_data'] ) ? $payload['form_data'] : array() );
		if ( is_wp_error( $form_data ) ) {
			return $form_data;
		}
		$form_data = self::form_data_without_resource_suffix( $form_data, $existing_resource_id );
		$form_data = self::form_data_with_date_times( $form_data, $dates );

		$params = self::booking_save_params( $payload );
		if ( is_wp_error( $params ) ) {
			return $params;
		}
		// Booking Calendar's edit API receives sync_gid again; preserve it unless the existing booking had none.
		$params['sync_gid'] = $existing_external_id;
		$params['is_edit_booking'] = array(
			'booking_id'   => $booking_id,
			'booking_type' => $existing_resource_id,
		);

		if ( ! array_key_exists( 'approved', $payload ) ) {
			$params['is_approve_booking'] = self::booking_is_approved( $booking_id ) ? 1 : 0;
		}

		// The developer edit helper always resolves the booking's current resource from
		// its hash. Save the proposed dates/form against that current resource first,
		// then use Booking Calendar's native resource-move SQL helper to rewrite every
		// form-field suffix and booking_type together. Passing the destination here
		// would tag fields for the new resource while saving the booking on the old one.
		global $wpdb;
		$wpdb->query( 'START TRANSACTION' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery

		$result = wpbc_api_booking_add_new( $dates, $form_data, $existing_resource_id, $params );
		if ( is_wp_error( $result ) ) {
			$wpdb->query( 'ROLLBACK' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			return new WP_Error( 'marina_booking_api_update_failed', $result->get_error_message(), array( 'status' => 422 ) );
		}

		if ( $is_resource_move ) {
			$move_result = wpbc__sql__change_booking_resource_for_booking( $booking_id, $resource_id );
			if ( ! is_array( $move_result ) || empty( $move_result[0] ) ) {
				$wpdb->query( 'ROLLBACK' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
				$message = is_array( $move_result ) && isset( $move_result[1] ) ? wp_strip_all_tags( (string) $move_result[1] ) : 'Booking Calendar could not move the booking to the requested resource.';
				return new WP_Error( 'marina_booking_api_resource_move_failed', $message, array( 'status' => 409 ) );
			}
		}

		// A resource change must never recalculate or replace the pricing note. Save the
		// exact note currently submitted by the app (or preserve the server note when
		// older clients omit it) after Booking Calendar has finished the edit/move.
		$current_note = isset( $existing['remark'] ) ? (string) $existing['remark'] : '';
		$note = array_key_exists( 'note', $payload ) ? self::sanitize_text( $payload['note'], 4000 ) : $current_note;
		$booking_table = $wpdb->prefix . 'booking';
		$note_updated = $wpdb->update( $booking_table, array( 'remark' => $note ), array( 'booking_id' => $booking_id ), array( '%s' ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		if ( false === $note_updated ) {
			$wpdb->query( 'ROLLBACK' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			return new WP_Error( 'marina_booking_api_note_failed', 'Could not preserve the booking note while editing.', array( 'status' => 500 ) );
		}

		$saved = self::raw_booking( $booking_id );
		$saved_form = ! is_wp_error( $saved ) && isset( $saved['form'] ) ? (string) $saved['form'] : '';
		$name_suffix_ok = ! isset( $form_data['name'] ) || preg_match( '/(?:^|~)[^^~]*\^name' . preg_quote( (string) $resource_id, '/' ) . '\^/', $saved_form );
		if (
			is_wp_error( $saved )
			|| (int) $saved['booking_type'] !== $resource_id
			|| ( isset( $saved['remark'] ) ? (string) $saved['remark'] : '' ) !== $note
			|| ! $name_suffix_ok
			|| ! self::saved_dates_match( $booking_id, $dates )
		) {
			$wpdb->query( 'ROLLBACK' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			return new WP_Error( 'marina_booking_api_edit_verification_failed', 'Booking Calendar did not persist the complete resource edit; all changes were rolled back.', array( 'status' => 500 ) );
		}

		$wpdb->query( 'COMMIT' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
		if ( array_key_exists( 'note', $payload ) && ! hash_equals( $current_note, $note ) ) {
			do_action(
				'wpbc_set_booking_note',
				array( 'booking_id' => $booking_id, 'note' => $note ),
				array( 'after_action_result' => true )
			);
			self::audit( 'booking_note_updated', $booking_id );
		}

		self::audit( 'booking_updated', $booking_id );
		return self::response( array( 'booking_id' => (int) $result, 'resource_id' => $resource_id, 'note' => $note, 'updated' => true ) );
	}

	/**
	 * Read one booking plus all stored dates. The Booking Calendar developer API
	 * returns a useful parsed form payload; dates are added here because its helper
	 * returns only one joined row by design.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function get_booking( WP_REST_Request $request ) {
		$booking_id = absint( $request['id'] );
		$booking    = self::raw_booking( $booking_id );
		if ( is_wp_error( $booking ) ) {
			return $booking;
		}

		return self::response( array( 'booking' => self::booking_details( $booking_id, $booking ) ) );
	}

	/**
	 * Look up exactly one booking by the immutable external ID saved in Booking
	 * Calendar's sync_gid field. This is intentionally exact-match only.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function get_booking_by_external_id( WP_REST_Request $request ) {
		return self::get_booking_by_external_id_value( $request['external_id'] );
	}

	/**
	 * @param mixed $external_id External booking ID.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function get_booking_by_external_id_value( $external_id ) {
		$external_id = self::validated_external_id( $external_id );
		if ( is_wp_error( $external_id ) ) {
			return $external_id;
		}
		$booking_id = self::find_booking_id_by_external_id( $external_id );
		if ( is_wp_error( $booking_id ) ) {
			return $booking_id;
		}
		if ( ! $booking_id ) {
			return new WP_Error( 'marina_booking_api_external_id_not_found', 'No booking exists for this external_id.', array( 'status' => 404 ) );
		}

		return self::response( array( 'booking' => self::booking_details( $booking_id ) ) );
	}

	/**
	 * List bookings with explicitly bounded result size. The installed Booking
	 * Calendar API marks this helper as deprecated, so this endpoint intentionally
	 * keeps the call isolated and limits it to 100 records.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function list_bookings( WP_REST_Request $request ) {
		if ( null !== $request->get_param( 'external_id' ) && '' !== (string) $request->get_param( 'external_id' ) ) {
			return self::get_booking_by_external_id_value( $request->get_param( 'external_id' ) );
		}

		if ( ! function_exists( 'wpbc_api_get_bookings_arr' ) ) {
			return new WP_Error( 'marina_booking_api_list_unavailable', 'The installed Booking Calendar version does not expose its booking-list helper.', array( 'status' => 501 ) );
		}

		$start = self::normalize_date_boundary( $request->get_param( 'start' ), true );
		$end   = self::normalize_date_boundary( $request->get_param( 'end' ), true );
		if ( is_wp_error( $start ) || is_wp_error( $end ) ) {
			return is_wp_error( $start ) ? $start : $end;
		}
		if ( strtotime( $start ) > strtotime( $end ) ) {
			return new WP_Error( 'marina_booking_api_invalid_range', 'The start date must be on or before the end date.', array( 'status' => 400 ) );
		}

		$resource_id = absint( $request->get_param( 'resource_id' ) );
		if ( $resource_id && ! self::resource_exists( $resource_id ) ) {
			return new WP_Error( 'marina_booking_api_invalid_resource', 'The booking resource does not exist.', array( 'status' => 422 ) );
		}

		$per_page = min( 100, max( 1, absint( $request->get_param( 'per_page' ) ? $request->get_param( 'per_page' ) : 50 ) ) );
		$page     = max( 1, absint( $request->get_param( 'page' ) ? $request->get_param( 'page' ) : 1 ) );
		$trash    = sanitize_key( (string) $request->get_param( 'trash' ) );
		if ( ! in_array( $trash, array( '', 'trash', 'any' ), true ) ) {
			return new WP_Error( 'marina_booking_api_invalid_trash_filter', 'trash must be empty, trash, or any.', array( 'status' => 400 ) );
		}

		$params = array(
			'wh_booking_type'  => $resource_id ? (string) $resource_id : '',
			'wh_booking_date'  => $start,
			'wh_booking_date2' => $end,
			'wh_trash'         => $trash,
			'page_num'         => (string) $page,
			'page_items_count' => (string) $per_page,
		);

		$results = wpbc_api_get_bookings_arr( $params );
		return self::response( array( 'result' => $results ) );
	}

	/**
	 * Set approved or pending status using the same hooks, log updates, conflict
	 * cleanup and optional mail functions as Booking Calendar's AJAX action.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function set_booking_status( WP_REST_Request $request ) {
		return self::execute_idempotent(
			$request,
			function() use ( $request ) {
				return self::set_booking_status_operation( $request );
			},
			false
		);
	}

	/**
	 * Internal operation invoked only after an idempotency key has been reserved.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function set_booking_status_operation( WP_REST_Request $request ) {
		$booking_id = absint( $request['id'] );
		$booking    = self::raw_booking( $booking_id );
		if ( is_wp_error( $booking ) ) {
			return $booking;
		}

		$payload = self::payload( $request );
		$status  = sanitize_key( isset( $payload['status'] ) ? $payload['status'] : '' );
		if ( ! in_array( $status, array( 'approved', 'pending' ), true ) ) {
			return new WP_Error( 'marina_booking_api_invalid_status', 'status must be approved or pending.', array( 'status' => 422 ) );
		}

		$approved   = ( 'approved' === $status ) ? 1 : 0;
		$send_email = self::boolean_from_payload( $payload, 'send_email', false );
		if ( is_wp_error( $send_email ) ) {
			return $send_email;
		}
		$reason     = self::sanitize_text( isset( $payload['reason'] ) ? $payload['reason'] : '', 1000 );
		global $wpdb;
		$table = $wpdb->prefix . 'bookingdates';
		$updated = $wpdb->query( $wpdb->prepare( "UPDATE {$table} SET approved = %d WHERE booking_id = %d", $approved, $booking_id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		if ( false === $updated ) {
			return new WP_Error( 'marina_booking_api_status_failed', 'Could not update the booking status.', array( 'status' => 500 ) );
		}

		$current_user = wp_get_current_user();
		if ( function_exists( 'wpbc_db__add_log_info' ) ) {
			$label = $approved ? __( 'Approved by:', 'booking' ) : __( 'Declined by:', 'booking' );
			wpbc_db__add_log_info( array( $booking_id ), $label . ' ' . $current_user->display_name . ' (' . $current_user->user_email . ')' );
		}
		if ( function_exists( 'wpbc_db_update_number_new_bookings' ) ) {
			wpbc_db_update_number_new_bookings( array( $booking_id ) );
		}
		do_action( 'wpbc_booking_approved', (string) $booking_id, (string) $approved );

		if ( $approved ) {
			if ( $send_email && function_exists( 'wpbc_send_email_approved' ) ) {
				wpbc_send_email_approved( (string) $booking_id, 1, $reason );
			}
			if ( function_exists( 'apply_bk_filter' ) ) {
				apply_bk_filter( 'cancel_pending_same_resource_bookings_for_specific_dates', false, (string) $booking_id );
			}
		} elseif ( $send_email && function_exists( 'wpbc_send_email_deny' ) ) {
			wpbc_send_email_deny( (string) $booking_id, 1, $reason );
		}

		self::audit( 'booking_status_' . $status, $booking_id );
		return self::response( array( 'booking_id' => $booking_id, 'status' => $status ) );
	}

	/**
	 * Update Booking Calendar's native remark field. This intentionally uses a
	 * prepared WordPress DB update because the Pro helper only saves remarks when
	 * a separate plugin option is enabled.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function set_booking_note( WP_REST_Request $request ) {
		return self::execute_idempotent(
			$request,
			function() use ( $request ) {
				return self::set_booking_note_operation( $request );
			},
			false
		);
	}

	/**
	 * Internal operation invoked only after an idempotency key has been reserved.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function set_booking_note_operation( WP_REST_Request $request ) {
		$booking_id = absint( $request['id'] );
		$booking    = self::raw_booking( $booking_id );
		if ( is_wp_error( $booking ) ) {
			return $booking;
		}

		$payload = self::payload( $request );
		$note    = self::sanitize_text( isset( $payload['note'] ) ? $payload['note'] : '', 4000 );
		global $wpdb;
		$table   = $wpdb->prefix . 'booking';
		$updated = $wpdb->update( $table, array( 'remark' => $note ), array( 'booking_id' => $booking_id ), array( '%s' ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		if ( false === $updated ) {
			return new WP_Error( 'marina_booking_api_note_failed', 'Could not update the booking note.', array( 'status' => 500 ) );
		}

		do_action(
			'wpbc_set_booking_note',
			array( 'booking_id' => $booking_id, 'note' => $note ),
			array( 'after_action_result' => true )
		);
		self::audit( 'booking_note_updated', $booking_id );
		return self::response( array( 'booking_id' => $booking_id, 'note' => $note ) );
	}

	public static function get_booking_payment( WP_REST_Request $request ) {
		$booking_id = absint( $request['id'] );
		$booking    = self::raw_booking( $booking_id );
		if ( is_wp_error( $booking ) ) {
			return $booking;
		}
		return self::response( self::booking_payment_payload( $booking_id, $booking ) );
	}

	public static function set_booking_deposit( WP_REST_Request $request ) {
		return self::execute_idempotent(
			$request,
			function() use ( $request ) { return self::set_booking_deposit_operation( $request ); },
			false
		);
	}

	private static function set_booking_deposit_operation( WP_REST_Request $request ) {
		$booking_id = absint( $request['id'] );
		$booking    = self::raw_booking( $booking_id );
		if ( is_wp_error( $booking ) ) {
			return $booking;
		}
		$payload       = self::payload( $request );
		$deposit       = isset( $payload['deposit'] ) && is_numeric( $payload['deposit'] ) ? (float) $payload['deposit'] : -1;
		$total         = isset( $payload['total'] ) && is_numeric( $payload['total'] ) ? (float) $payload['total'] : -1;
		$expected_note = isset( $payload['expected_note'] ) ? (string) $payload['expected_note'] : '';
		if ( $deposit < 0 || $total <= 0 || $deposit > $total || abs( $deposit * 100 - round( $deposit * 100 ) ) > 0.00001 ) {
			return new WP_Error( 'marina_booking_api_invalid_deposit', 'deposit must be non-negative, no greater than total, and have at most two decimals.', array( 'status' => 422 ) );
		}
		$current_note = isset( $booking['remark'] ) ? (string) $booking['remark'] : '';
		if ( ! hash_equals( $current_note, $expected_note ) ) {
			return new WP_Error( 'marina_booking_api_note_conflict', 'The booking note changed after this deposit was queued.', array( 'status' => 409, 'current_note' => $current_note ) );
		}
		$pricing = self::parse_pricing_note( $current_note );
		if ( is_wp_error( $pricing ) ) {
			return $pricing;
		}
		if ( abs( $pricing['total'] - $total ) > 0.005 ) {
			return new WP_Error( 'marina_booking_api_total_conflict', 'The supplied total does not match the Cost saved in the booking note.', array( 'status' => 409 ) );
		}
		$balance = round( $total - $deposit, 2 );
		$line    = 'Cost total: ' . self::format_note_amount( $total ) . ' RON, Depozit: ' . self::format_note_amount( $deposit ) . ' RON, Rest: ' . self::format_note_amount( $balance ) . ' RON';
		$note    = preg_replace( self::pricing_note_pattern(), $line, $current_note, 1, $replacement_count );
		if ( 1 !== $replacement_count ) {
			return new WP_Error( 'marina_booking_api_pricing_note_missing', 'The booking note does not contain canonical pricing values.', array( 'status' => 422 ) );
		}
		global $wpdb;
		$table = $wpdb->prefix . 'booking';
		$wpdb->query( 'START TRANSACTION' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
		$updated = $wpdb->query( $wpdb->prepare( "UPDATE {$table} SET cost = %f, remark = %s WHERE booking_id = %d AND remark = %s", $deposit, $note, $booking_id, $expected_note ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( false === $updated ) {
			$wpdb->query( 'ROLLBACK' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			return new WP_Error( 'marina_booking_api_deposit_failed', 'Could not update the booking deposit and note.', array( 'status' => 500 ) );
		}
		if ( 0 === $updated ) {
			$latest = self::raw_booking( $booking_id );
			$same_result = ! is_wp_error( $latest ) && isset( $latest['remark'], $latest['cost'] ) && hash_equals( $note, (string) $latest['remark'] ) && abs( (float) $latest['cost'] - $deposit ) < 0.005;
			if ( ! $same_result ) {
				$wpdb->query( 'ROLLBACK' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
				$current = is_wp_error( $latest ) ? '' : (string) $latest['remark'];
				return new WP_Error( 'marina_booking_api_note_conflict', 'The booking note changed while the deposit was being saved.', array( 'status' => 409, 'current_note' => $current ) );
			}
		}
		$wpdb->query( 'COMMIT' ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
		do_action( 'wpbc_booking_action__set_booking_cost', $booking_id, $deposit, isset( $booking['cost'] ) ? (float) $booking['cost'] : 0 );
		do_action( 'wpbc_set_booking_note', array( 'booking_id' => $booking_id, 'note' => $note ), array( 'after_action_result' => true ) );
		self::audit( 'booking_deposit_updated', $booking_id );
		return self::response( array( 'booking_id' => $booking_id, 'deposit' => $deposit, 'total' => $total, 'balance' => $balance, 'note' => $note, 'formatted' => array( 'deposit' => self::format_booking_cost( $deposit, isset( $booking['booking_type'] ) ? $booking['booking_type'] : 0 ), 'total' => self::format_booking_cost( $total, isset( $booking['booking_type'] ) ? $booking['booking_type'] : 0 ), 'balance' => self::format_booking_cost( $balance, isset( $booking['booking_type'] ) ? $booking['booking_type'] : 0 ) ) ) );
	}

	public static function send_booking_payment_request( WP_REST_Request $request ) {
		return self::execute_idempotent(
			$request,
			function() use ( $request ) { return self::send_booking_payment_request_operation( $request ); },
			false
		);
	}

	private static function payment_request_data( $booking_id, $payload ) {
		$reason     = isset( $payload['reason'] ) ? (string) $payload['reason'] : '';
		$start_date = isset( $payload['start_date'] ) ? (string) $payload['start_date'] : '';
		$end_date   = isset( $payload['end_date'] ) ? (string) $payload['end_date'] : '';
		$nights     = isset( $payload['nights'] ) ? (int) $payload['nights'] : 0;
		if ( 1 !== preg_match( '/^[A-Za-z]{6}$/D', $reason ) ) {
			return new WP_Error( 'marina_booking_api_payment_reason_invalid', 'The EuPlatesc payment identifier must contain exactly 6 letters.', array( 'status' => 422 ) );
		}
		if ( ! self::is_iso_date( $start_date ) || ! self::is_iso_date( $end_date ) || $start_date > $end_date ) {
			return new WP_Error( 'marina_booking_api_payment_dates_invalid', 'The payment request requires valid start_date and end_date values in YYYY-MM-DD format.', array( 'status' => 422 ) );
		}
		$expected_nights = max( 1, (int) ( new DateTimeImmutable( $start_date ) )->diff( new DateTimeImmutable( $end_date ) )->format( '%a' ) );
		if ( $nights !== $expected_nights ) {
			return new WP_Error( 'marina_booking_api_payment_nights_invalid', 'The number of nights does not match the reservation period.', array( 'status' => 422 ) );
		}
		$stored_dates = array_values(
			array_unique(
				array_map(
					function( $row ) { return substr( (string) $row['date'], 0, 10 ); },
					self::booking_dates( $booking_id )
				)
			)
		);
		if ( empty( $stored_dates ) || $start_date !== $stored_dates[0] || $end_date !== $stored_dates[ count( $stored_dates ) - 1 ] ) {
			return new WP_Error( 'marina_booking_api_payment_period_conflict', 'The supplied payment period does not match the dates saved for this reservation.', array( 'status' => 409 ) );
		}
		$stored_nights = count( $stored_dates ) > 1 ? count( $stored_dates ) - 1 : count( $stored_dates );
		if ( $nights !== $stored_nights ) {
			return new WP_Error( 'marina_booking_api_payment_period_conflict', 'The supplied number of nights does not match the dates saved for this reservation.', array( 'status' => 409 ) );
		}
		return array( 'reason' => $reason, 'start_date' => $start_date, 'end_date' => $end_date, 'nights' => $nights, 'dates' => $stored_dates );
	}

	private static function is_iso_date( $value ) {
		$date = DateTimeImmutable::createFromFormat( '!Y-m-d', (string) $value );
		return false !== $date && $date->format( 'Y-m-d' ) === $value;
	}

	private static function payment_request_form( $form, $resource_id, $payment ) {
		if ( ! function_exists( 'wpbc_get_dates_short_format' ) ) {
			return new WP_Error( 'marina_booking_api_payment_form_failed', 'The EuPlatesc payment form could not be generated because Booking Calendar date formatting is unavailable.', array( 'status' => 502 ) );
		}
		$short_dates = wp_strip_all_tags( (string) wpbc_get_dates_short_format( implode( ',', $payment['dates'] ) ) );
		if ( '' === $short_dates || false !== strpos( $short_dates, '^' ) || false !== strpos( $short_dates, '~' ) ) {
			return new WP_Error( 'marina_booking_api_payment_form_failed', 'The EuPlatesc payment form could not be generated from the reservation dates.', array( 'status' => 502 ) );
		}
		$fields = array_filter( explode( '~', (string) $form ), 'strlen' );
		$names  = array( 'selected_short_dates_hint' . $resource_id, 'nights_number_hint' . $resource_id );
		$fields = array_values(
			array_filter(
				$fields,
				function( $field ) use ( $names ) {
					$parts = explode( '^', $field, 3 );
					return ! isset( $parts[1] ) || ! in_array( $parts[1], $names, true );
				}
			)
		);
		$fields[] = 'text^' . $names[0] . '^' . $short_dates;
		$fields[] = 'text^' . $names[1] . '^' . (int) $payment['nights'];
		return implode( '~', $fields );
	}

	private static function send_booking_payment_request_operation( WP_REST_Request $request ) {
		$booking_id = absint( $request['id'] );
		$booking    = self::raw_booking( $booking_id );
		if ( is_wp_error( $booking ) ) {
			return $booking;
		}
		if ( ! empty( $booking['trash'] ) ) {
			return new WP_Error( 'marina_booking_api_booking_trashed', 'A payment request cannot be sent for a trashed booking.', array( 'status' => 409 ) );
		}
		if ( ! class_exists( 'wpdev_bk_biz_s' ) || ! function_exists( 'wpbc_send_email_payment_request' ) ) {
			return new WP_Error( 'marina_booking_api_payment_unavailable', 'Booking Calendar payment requests require Business Medium or higher.', array( 'status' => 501 ) );
		}
		if ( 'Off' === get_bk_option( 'booking_is_email_payment_request_adress' ) ) {
			return new WP_Error( 'marina_booking_api_payment_email_disabled', 'The Booking Calendar Payment Request email is disabled.', array( 'status' => 409 ) );
		}
		$email = self::booking_email( isset( $booking['form'] ) ? $booking['form'] : '' );
		if ( ! $email ) {
			return new WP_Error( 'marina_booking_api_client_email_missing', 'The booking does not contain a valid client email.', array( 'status' => 422 ) );
		}
		$payload = self::payload( $request );
		$payment = self::payment_request_data( $booking_id, $payload );
		if ( is_wp_error( $payment ) ) {
			return $payment;
		}
		$form = self::payment_request_form( (string) $booking['form'], (int) $booking['booking_type'], $payment );
		if ( is_wp_error( $form ) ) {
			return $form;
		}
		global $wpdb;
		$table = $wpdb->prefix . 'booking';
		if ( ! hash_equals( (string) $booking['form'], $form ) ) {
			$form_updated = $wpdb->query( $wpdb->prepare( "UPDATE {$table} SET form = %s WHERE booking_id = %d AND form = %s", $form, $booking_id, (string) $booking['form'] ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			if ( 1 !== $form_updated ) {
				return new WP_Error( 'marina_booking_api_payment_form_conflict', 'The reservation changed while the EuPlatesc payment form was being prepared.', array( 'status' => 409 ) );
			}
		}
		$reason = $payment['reason'];
		$sent   = wpbc_send_email_payment_request( $booking_id, (int) $booking['booking_type'], $form, $reason );
		if ( ! $sent ) {
			return new WP_Error( 'marina_booking_api_payment_email_failed', 'Booking Calendar could not generate or send the EuPlatesc payment request email.', array( 'status' => 502 ) );
		}
		$updated       = $wpdb->query( $wpdb->prepare( "UPDATE {$table} SET pay_request = COALESCE(pay_request, 0) + 1 WHERE booking_id = %d", $booking_id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$request_count = false === $updated ? ( isset( $booking['pay_request'] ) ? (int) $booking['pay_request'] : 0 ) : (int) $wpdb->get_var( $wpdb->prepare( "SELECT pay_request FROM {$table} WHERE booking_id = %d", $booking_id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching,WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( 1 !== $updated ) {
			self::audit( 'booking_payment_request_counter_failed', $booking_id );
		}
		do_action( 'wpbc_booking_action__send_payment_request', $booking_id, $reason, isset( $booking['cost'] ) ? (float) $booking['cost'] : 0 );
		self::audit( 'booking_payment_request_sent', $booking_id );
		return self::response( array( 'booking_id' => $booking_id, 'sent' => true, 'email' => $email, 'deposit' => isset( $booking['cost'] ) ? (float) $booking['cost'] : 0, 'reason' => $reason, 'nights' => $payment['nights'], 'start_date' => $payment['start_date'], 'end_date' => $payment['end_date'], 'request_count' => $request_count, 'counter_updated' => 1 === $updated ) );
	}

	private static function booking_payment_payload( $booking_id, $booking ) {
		$pricing = self::parse_pricing_note( isset( $booking['remark'] ) ? $booking['remark'] : '' );
		$resource_id = isset( $booking['booking_type'] ) ? (int) $booking['booking_type'] : 0;
		$deposit = isset( $booking['cost'] ) ? (float) $booking['cost'] : null;
		return array(
			'booking_id'       => (int) $booking_id,
			'note'             => isset( $booking['remark'] ) ? (string) $booking['remark'] : '',
			'deposit'          => $deposit,
			'total'            => is_wp_error( $pricing ) ? null : $pricing['total'],
			'balance'          => is_wp_error( $pricing ) ? null : $pricing['balance'],
			'formatted'        => array(
				'deposit' => null === $deposit ? '' : self::format_booking_cost( $deposit, $resource_id ),
				'total'   => is_wp_error( $pricing ) ? '' : self::format_booking_cost( $pricing['total'], $resource_id ),
				'balance' => is_wp_error( $pricing ) ? '' : self::format_booking_cost( $pricing['balance'], $resource_id ),
			),
			'payment_status'   => isset( $booking['pay_status'] ) ? (string) $booking['pay_status'] : '',
			'request_count'    => isset( $booking['pay_request'] ) ? (int) $booking['pay_request'] : 0,
			'email_available'  => class_exists( 'wpdev_bk_biz_s' ) && function_exists( 'wpbc_send_email_payment_request' ) && 'Off' !== get_bk_option( 'booking_is_email_payment_request_adress' ),
			'email'            => self::booking_email( isset( $booking['form'] ) ? $booking['form'] : '' ),
		);
	}

	private static function parse_pricing_note( $note ) {
		if ( ! preg_match( self::pricing_note_pattern(), (string) $note, $matches ) ) {
			return new WP_Error( 'marina_booking_api_pricing_note_missing', 'The booking note does not contain canonical pricing values.', array( 'status' => 422 ) );
		}
		$canonical = isset( $matches['total'] ) && '' !== $matches['total'];
		$deposit   = self::parse_note_amount( $canonical ? $matches['deposit'] : $matches['legacy_deposit'] );
		$total     = self::parse_note_amount( $canonical ? $matches['total'] : $matches['legacy_total'] );
		$balance   = self::parse_note_amount( $canonical ? $matches['balance'] : $matches['legacy_balance'] );
		if ( null === $deposit || null === $total || null === $balance ) {
			return new WP_Error( 'marina_booking_api_pricing_note_invalid', 'The booking pricing note contains invalid amounts.', array( 'status' => 422 ) );
		}
		return array( 'deposit' => $deposit, 'total' => $total, 'balance' => $balance );
	}

	private static function pricing_note_pattern() {
		$amount = '(?:\\d+\\.\\d{1,2}|\\d+(?:[.\\s]\\d{3})*(?:,\\d{1,2})?)';
		return '/(?:Cost total:\\s*(?<total>' . $amount . ')\\s*RON,\\s*Depozit:\\s*(?<deposit>' . $amount . ')\\s*RON,\\s*Rest:\\s*(?<balance>' . $amount . ')\\s*RON|Avans:\\s*(?<legacy_deposit>' . $amount . '),\\s*Cost:\\s*(?<legacy_total>' . $amount . '),\\s*Rest:\\s*(?<legacy_balance>' . $amount . '))(?![\\d.,])/iu';
	}

	private static function parse_note_amount( $value ) {
		$value = preg_replace( '/\s+/u', '', trim( (string) $value ) );
		$value = preg_replace( '/\.(?=\d{3}(?:\D|$))/', '', $value );
		$value = str_replace( ',', '.', $value );
		return preg_match( '/^\d+(?:\.\d{1,2})?$/', $value ) ? (float) $value : null;
	}

	private static function format_note_amount( $value ) {
		$formatted = number_format( (float) $value, 2, ',', '.' );
		return rtrim( rtrim( $formatted, '0' ), ',' );
	}

	private static function booking_email( $form ) {
		if ( preg_match_all( '/\^([^~^]+)(?:~|$)/u', (string) $form, $matches ) ) {
			foreach ( $matches[1] as $value ) {
				$value = sanitize_email( html_entity_decode( $value, ENT_QUOTES, 'UTF-8' ) );
				if ( is_email( $value ) ) return $value;
			}
		}
		return '';
	}

	/**
	 * Trash or restore without enabling permanent deletion through the API.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	public static function set_booking_trash( WP_REST_Request $request ) {
		return self::execute_idempotent(
			$request,
			function() use ( $request ) {
				return self::set_booking_trash_operation( $request );
			},
			false
		);
	}

	/**
	 * Internal operation invoked only after an idempotency key has been reserved.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function set_booking_trash_operation( WP_REST_Request $request ) {
		$booking_id = absint( $request['id'] );
		$booking    = self::raw_booking( $booking_id );
		if ( is_wp_error( $booking ) ) {
			return $booking;
		}

		$payload    = self::payload( $request );
		$is_trash   = self::boolean_from_payload( $payload, 'trash', false );
		$send_email = self::boolean_from_payload( $payload, 'send_email', false );
		if ( is_wp_error( $is_trash ) ) {
			return $is_trash;
		}
		if ( is_wp_error( $send_email ) ) {
			return $send_email;
		}
		$is_trash   = $is_trash ? 1 : 0;
		$reason     = self::sanitize_text( isset( $payload['reason'] ) ? $payload['reason'] : '', 1000 );

		do_action( 'wpbc_booking_trash', (string) $booking_id, $is_trash );
		if ( $is_trash && $send_email && function_exists( 'wpbc_send_email_trash' ) ) {
			wpbc_send_email_trash( (string) $booking_id, 1, $reason );
		}

		global $wpdb;
		$table   = $wpdb->prefix . 'booking';
		$updated = $wpdb->update( $table, array( 'trash' => $is_trash ), array( 'booking_id' => $booking_id ), array( '%d' ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		if ( false === $updated ) {
			return new WP_Error( 'marina_booking_api_trash_failed', 'Could not update the booking trash state.', array( 'status' => 500 ) );
		}

		if ( function_exists( 'wpbc_hash__update_booking_hash' ) ) {
			wpbc_hash__update_booking_hash( $booking_id );
		}

		self::audit( $is_trash ? 'booking_trashed' : 'booking_restored', $booking_id );
		return self::response( array( 'booking_id' => $booking_id, 'trash' => (bool) $is_trash ) );
	}

	/**
	 * Reserve an idempotency key before any Booking Calendar mutation. The write
	 * operation is called once only for a new reservation record; repeated keys
	 * return the original response rather than executing again.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @param callable        $operation Mutation callback.
	 * @param bool            $is_create Whether this is a create operation.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function execute_idempotent( WP_REST_Request $request, $operation, $is_create ) {
		$payload = self::payload( $request );
		$key     = self::idempotency_key_from_request( $request );
		if ( is_wp_error( $key ) ) {
			return $key;
		}

		$external_id = null;
		if ( $is_create ) {
			$external_id = self::validated_external_id( isset( $payload['external_id'] ) ? $payload['external_id'] : '' );
			if ( is_wp_error( $external_id ) ) {
				return $external_id;
			}
			$payload['external_id'] = $external_id;
		}

		$context = array(
			'user_id'          => (int) get_current_user_id(),
			'route'            => (string) $request->get_route(),
			'route_hash'       => hash( 'sha256', (string) $request->get_route() ),
			'key_hash'         => hash( 'sha256', $key ),
			'request_hash'     => self::request_hash( $request, $payload ),
			'external_id'      => $external_id,
			'external_id_hash' => null === $external_id ? null : hash( 'sha256', $external_id ),
			'is_create'        => (bool) $is_create,
		);

		$reservation = self::reserve_idempotency_record( $context );
		if ( is_wp_error( $reservation ) ) {
			return $reservation;
		}
		if ( isset( $reservation['response'] ) ) {
			return $reservation['response'];
		}

		try {
			$result = call_user_func( $operation );
		} catch ( Throwable $exception ) {
			self::mark_idempotency_unknown( (int) $reservation['id'] );
			error_log( 'Marina Booking API: an idempotent write ended unexpectedly.' );
			return new WP_Error( 'marina_booking_api_write_outcome_unknown', 'The server could not confirm this write. Retry only with the same Idempotency-Key or reconcile by external_id.', array( 'status' => 500 ) );
		}

		// For a failed create, reconciliation by external_id is still safer than a retry.
		if ( $result instanceof WP_Error && $is_create ) {
			$reconciled_id = self::find_booking_id_by_external_id( $external_id );
			if ( ! is_wp_error( $reconciled_id ) && $reconciled_id ) {
				$result = self::response( array( 'booking_id' => (int) $reconciled_id, 'reconciled' => true ), 200 );
			}
		}

		return self::finalize_idempotency_record( (int) $reservation['id'], $result, $context );
	}

	/**
	 * Atomically reserve a request key. A create also reserves its external_id,
	 * preventing two different idempotency keys from creating the same booking.
	 *
	 * @param array $context Idempotency context.
	 * @return array|WP_Error
	 */
	private static function reserve_idempotency_record( $context ) {
		global $wpdb;
		$table = self::idempotency_table();

		$existing = self::get_idempotency_record_by_key( $context );
		if ( $existing ) {
			return self::resolve_existing_idempotency_record( $existing, $context );
		}

		// A legacy or prior booking can exist without a local idempotency record.
		if ( $context['is_create'] ) {
			$existing_booking_id = self::find_booking_id_by_external_id( $context['external_id'] );
			if ( is_wp_error( $existing_booking_id ) ) {
				return $existing_booking_id;
			}
			if ( $existing_booking_id ) {
				$response = self::response( array( 'booking_id' => (int) $existing_booking_id, 'reconciled' => true ), 200 );
				$stored   = self::insert_completed_idempotency_record( $context, $response, (int) $existing_booking_id );
				if ( is_wp_error( $stored ) ) {
					return $stored;
				}
				return array( 'response' => $response );
			}
		}

		$now      = current_time( 'mysql', true );
		$inserted = $wpdb->insert(
			$table,
			array(
				'user_id'          => $context['user_id'],
				'route_hash'       => $context['route_hash'],
				'key_hash'         => $context['key_hash'],
				'request_hash'     => $context['request_hash'],
				'external_id'      => $context['external_id'],
				'external_id_hash' => $context['external_id_hash'],
				'state'            => 'processing',
				'created_at'       => $now,
				'updated_at'       => $now,
			),
			array( '%d', '%s', '%s', '%s', '%s', '%s', '%s', '%s', '%s' )
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching

		if ( false !== $inserted ) {
			return array( 'id' => (int) $wpdb->insert_id );
		}

		// A duplicate can be either the same idempotency key or, for create, a
		// competing request that used the same external_id. Resolve without running
		// any Booking Calendar mutation a second time.
		$existing = self::get_idempotency_record_by_key( $context );
		if ( $existing ) {
			return self::resolve_existing_idempotency_record( $existing, $context );
		}
		if ( $context['is_create'] ) {
			$external_record = self::get_idempotency_record_by_external_id( $context['external_id_hash'] );
			if ( $external_record ) {
				return self::resolve_external_id_collision( $external_record, $context );
			}
		}

		return new WP_Error( 'marina_booking_api_idempotency_reservation_failed', 'Could not reserve the idempotency key. Please retry with the same key.', array( 'status' => 503 ) );
	}

	/**
	 * @param array $context Context.
	 * @return array|null
	 */
	private static function get_idempotency_record_by_key( $context ) {
		global $wpdb;
		$table = self::idempotency_table();
		return $wpdb->get_row(
			$wpdb->prepare(
				"SELECT * FROM {$table} WHERE user_id = %d AND route_hash = %s AND key_hash = %s LIMIT 1",
				$context['user_id'],
				$context['route_hash'],
				$context['key_hash']
			),
			ARRAY_A
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
	}

	/**
	 * @param string $external_id_hash SHA-256 external ID hash.
	 * @return array|null
	 */
	private static function get_idempotency_record_by_external_id( $external_id_hash ) {
		global $wpdb;
		$table = self::idempotency_table();
		return $wpdb->get_row(
			$wpdb->prepare( "SELECT * FROM {$table} WHERE external_id_hash = %s LIMIT 1", $external_id_hash ),
			ARRAY_A
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
	}

	/**
	 * @param array $row Existing database row.
	 * @param array $context Request context.
	 * @return array|WP_Error
	 */
	private static function resolve_existing_idempotency_record( $row, $context ) {
		if ( ! hash_equals( (string) $row['request_hash'], (string) $context['request_hash'] ) ) {
			return new WP_Error( 'marina_booking_api_idempotency_key_reused', 'This Idempotency-Key was already used with a different request payload.', array( 'status' => 409 ) );
		}

		if ( 'completed' === $row['state'] ) {
			return array( 'response' => self::response_from_idempotency_record( $row ) );
		}

		if ( $context['is_create'] && ! empty( $context['external_id'] ) ) {
			$booking_id = self::find_booking_id_by_external_id( $context['external_id'] );
			if ( is_wp_error( $booking_id ) ) {
				return $booking_id;
			}
			if ( $booking_id ) {
				$response = self::response( array( 'booking_id' => (int) $booking_id, 'reconciled' => true ), 200 );
				self::complete_idempotency_record( (int) $row['id'], $response, (int) $booking_id );
				return array( 'response' => $response );
			}
		}

		return self::pending_idempotency_error( $row );
	}

	/**
	 * @param array $row Existing row for the same external_id.
	 * @param array $context Request context.
	 * @return array|WP_Error
	 */
	private static function resolve_external_id_collision( $row, $context ) {
		if ( ! hash_equals( (string) $row['request_hash'], (string) $context['request_hash'] ) ) {
			return new WP_Error( 'marina_booking_api_external_id_reused', 'This external_id is already reserved for a different create request.', array( 'status' => 409 ) );
		}

		if ( 'completed' === $row['state'] ) {
			if ( ! empty( $row['booking_id'] ) ) {
				return array( 'response' => self::response( array( 'booking_id' => (int) $row['booking_id'], 'reconciled' => true ), 200 ) );
			}
			return array( 'response' => self::response_from_idempotency_record( $row ) );
		}

		$booking_id = self::find_booking_id_by_external_id( $context['external_id'] );
		if ( is_wp_error( $booking_id ) ) {
			return $booking_id;
		}
		if ( $booking_id ) {
			$response = self::response( array( 'booking_id' => (int) $booking_id, 'reconciled' => true ), 200 );
			self::complete_idempotency_record( (int) $row['id'], $response, (int) $booking_id );
			return array( 'response' => $response );
		}

		return self::pending_idempotency_error( $row );
	}

	/**
	 * @param array $row Idempotency DB row.
	 * @return WP_Error
	 */
	private static function pending_idempotency_error( $row ) {
		$age = max( 0, time() - strtotime( (string) $row['updated_at'] . ' UTC' ) );
		if ( $age < 120 && 'processing' === $row['state'] ) {
			return new WP_Error(
				'marina_booking_api_request_in_progress',
				'This idempotent request is still being processed. Retry with the same Idempotency-Key shortly.',
				array( 'status' => 409, 'retry_after' => 2 )
			);
		}

		return new WP_Error( 'marina_booking_api_write_outcome_unknown', 'The prior write has an unknown outcome. Do not retry it with a new key; reconcile the booking first.', array( 'status' => 409 ) );
	}

	/**
	 * @param int                       $id      Idempotency row ID.
	 * @param WP_REST_Response|WP_Error $result  Operation result.
	 * @param array                     $context Request context.
	 * @return WP_REST_Response|WP_Error
	 */
	private static function finalize_idempotency_record( $id, $result, $context ) {
		if ( $result instanceof WP_Error ) {
			$status = self::status_from_error( $result );
			if ( $status >= 500 ) {
				self::release_idempotency_reservation( $id );
				return $result;
			}
			$response = rest_ensure_response( $result );
			self::complete_idempotency_record( $id, $response, 0 );
			return $result;
		}

		$response = rest_ensure_response( $result );
		$booking_id = 0;
		$data = $response->get_data();
		if ( is_array( $data ) && isset( $data['booking_id'] ) ) {
			$booking_id = absint( $data['booking_id'] );
		}
		self::complete_idempotency_record( $id, $response, $booking_id );
		return $response;
	}

	/**
	 * Release a known failed write so retrying the same key can execute again.
	 * Exceptions keep the row in unknown state because their side effects cannot
	 * be determined safely.
	 *
	 * @param int $id Idempotency row ID.
	 * @return void
	 */
	private static function release_idempotency_reservation( $id ) {
		global $wpdb;
		$wpdb->delete( self::idempotency_table(), array( 'id' => $id, 'state' => 'processing' ), array( '%d', '%s' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
	}

	/**
	 * @param array            $context  Context.
	 * @param WP_REST_Response $response Completed response.
	 * @param int              $booking_id Booking ID.
	 * @return bool|WP_Error
	 */
	private static function insert_completed_idempotency_record( $context, WP_REST_Response $response, $booking_id ) {
		global $wpdb;
		$table = self::idempotency_table();
		$now = current_time( 'mysql', true );
		$inserted = $wpdb->insert(
			$table,
			array(
				'user_id'          => $context['user_id'],
				'route_hash'       => $context['route_hash'],
				'key_hash'         => $context['key_hash'],
				'request_hash'     => $context['request_hash'],
				'external_id'      => $context['external_id'],
				'external_id_hash' => $context['external_id_hash'],
				'state'            => 'completed',
				'response_code'    => $response->get_status(),
				'response_body'    => wp_json_encode( $response->get_data() ),
				'booking_id'       => $booking_id ? $booking_id : null,
				'created_at'       => $now,
				'updated_at'       => $now,
			),
			array( '%d', '%s', '%s', '%s', '%s', '%s', '%s', '%d', '%s', '%d', '%s', '%s' )
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		if ( false !== $inserted ) {
			return true;
		}
		$existing = self::get_idempotency_record_by_key( $context );
		if ( $existing ) {
			return true;
		}
		return new WP_Error( 'marina_booking_api_idempotency_store_failed', 'Could not store the idempotent response.', array( 'status' => 500 ) );
	}

	/**
	 * @param int              $id Idempotency row ID.
	 * @param WP_REST_Response $response Completed response.
	 * @param int              $booking_id Booking ID.
	 * @return void
	 */
	private static function complete_idempotency_record( $id, WP_REST_Response $response, $booking_id ) {
		global $wpdb;
		$wpdb->update(
			self::idempotency_table(),
			array(
				'state'         => 'completed',
				'response_code' => $response->get_status(),
				'response_body' => wp_json_encode( $response->get_data() ),
				'booking_id'    => $booking_id ? $booking_id : null,
				'updated_at'    => current_time( 'mysql', true ),
			),
			array( 'id' => $id ),
			array( '%s', '%d', '%s', '%d', '%s' ),
			array( '%d' )
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
	}

	/**
	 * @param int $id Idempotency row ID.
	 * @return void
	 */
	private static function mark_idempotency_unknown( $id ) {
		global $wpdb;
		$wpdb->update(
			self::idempotency_table(),
			array(
				'state'      => 'unknown',
				'updated_at' => current_time( 'mysql', true ),
			),
			array( 'id' => $id ),
			array( '%s', '%s' ),
			array( '%d' )
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
	}

	/**
	 * @param array $row Idempotency row.
	 * @return WP_REST_Response
	 */
	private static function response_from_idempotency_record( $row ) {
		$data = json_decode( (string) $row['response_body'], true );
		if ( JSON_ERROR_NONE !== json_last_error() ) {
			return self::response( array( 'message' => 'The original idempotent response could not be decoded.' ), 500 );
		}
		$status = (int) $row['response_code'];
		if ( $status < 100 || $status > 599 ) {
			$status = 500;
		}
		return self::response( $data, $status );
	}

	/**
	 * @param WP_REST_Request $request REST request.
	 * @return string|WP_Error
	 */
	private static function idempotency_key_from_request( WP_REST_Request $request ) {
		$key = trim( (string) $request->get_header( 'Idempotency-Key' ) );
		if ( '' === $key ) {
			return new WP_Error( 'marina_booking_api_idempotency_key_required', 'Idempotency-Key is required for every write request.', array( 'status' => 400 ) );
		}
		if ( strlen( $key ) < 16 || strlen( $key ) > 128 || ! preg_match( '/^[A-Za-z0-9._:-]+$/', $key ) ) {
			return new WP_Error( 'marina_booking_api_invalid_idempotency_key', 'Idempotency-Key must contain 16 to 128 letters, numbers, dots, underscores, colons, or hyphens.', array( 'status' => 422 ) );
		}
		return $key;
	}

	/**
	 * @param WP_REST_Request $request REST request.
	 * @param array           $payload Normalized payload.
	 * @return string
	 */
	private static function request_hash( WP_REST_Request $request, $payload ) {
		return hash( 'sha256', strtoupper( $request->get_method() ) . "\n" . $request->get_route() . "\n" . self::canonical_json( $payload ) );
	}

	/**
	 * Stable payload hashing: key ordering does not change an idempotency request.
	 *
	 * @param mixed $value Input value.
	 * @return string
	 */
	private static function canonical_json( $value ) {
		if ( is_array( $value ) ) {
			if ( self::is_list_array( $value ) ) {
				$items = array();
				foreach ( $value as $item ) {
					$items[] = json_decode( self::canonical_json( $item ), true );
				}
				return wp_json_encode( $items );
			}
			ksort( $value, SORT_STRING );
			$result = array();
			foreach ( $value as $key => $item ) {
				$result[ (string) $key ] = json_decode( self::canonical_json( $item ), true );
			}
			return wp_json_encode( $result );
		}
		return wp_json_encode( $value );
	}

	/**
	 * @param array $array Candidate array.
	 * @return bool
	 */
	private static function is_list_array( $array ) {
		$expected = 0;
		foreach ( array_keys( $array ) as $key ) {
			if ( $expected !== $key ) {
				return false;
			}
			$expected++;
		}
		return true;
	}

	/**
	 * @param mixed $external_id External ID.
	 * @return string|WP_Error
	 */
	private static function validated_external_id( $external_id ) {
		if ( is_array( $external_id ) || is_object( $external_id ) ) {
			return new WP_Error( 'marina_booking_api_invalid_external_id', 'external_id must be a string.', array( 'status' => 422 ) );
		}
		$external_id = trim( (string) $external_id );
		if ( ! preg_match( '/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/', $external_id ) ) {
			return new WP_Error( 'marina_booking_api_invalid_external_id', 'external_id must be 8 to 120 characters using letters, numbers, dots, underscores, colons, or hyphens.', array( 'status' => 422 ) );
		}
		return $external_id;
	}

	/**
	 * @param string $external_id Valid external ID.
	 * @return int|WP_Error
	 */
	private static function find_booking_id_by_external_id( $external_id ) {
		global $wpdb;
		$table = $wpdb->prefix . 'booking';
		$ids = $wpdb->get_col(
			$wpdb->prepare( "SELECT booking_id FROM {$table} WHERE sync_gid = %s ORDER BY booking_id ASC LIMIT 2", $external_id )
		); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		if ( count( $ids ) > 1 ) {
			return new WP_Error( 'marina_booking_api_external_id_not_unique', 'More than one booking has this external_id. Manual intervention is required.', array( 'status' => 409 ) );
		}
		return empty( $ids ) ? 0 : absint( $ids[0] );
	}

	/**
	 * @param WP_Error $error WordPress error.
	 * @return int
	 */
	private static function status_from_error( WP_Error $error ) {
		$data = $error->get_error_data();
		return ( is_array( $data ) && ! empty( $data['status'] ) ) ? (int) $data['status'] : 500;
	}

	/**
	 * @param int        $booking_id Booking ID.
	 * @param array|null $booking Existing raw booking.
	 * @return array
	 */
	private static function booking_details( $booking_id, $booking = null ) {
		$booking = is_array( $booking ) ? $booking : self::raw_booking( $booking_id );
		if ( is_wp_error( $booking ) ) {
			return array();
		}
		$booking['dates']  = self::booking_dates( $booking_id );
		$booking['status'] = self::booking_is_approved( $booking_id ) ? 'approved' : 'pending';
		$booking['trash']  = ! empty( $booking['trash'] );
		return $booking;
	}

	/**
	 * Return a minimal internal booking record and reject missing IDs.
	 *
	 * @param int $booking_id Booking ID.
	 * @return array|WP_Error
	 */
	private static function raw_booking( $booking_id ) {
		if ( $booking_id < 1 || ! function_exists( 'wpbc_api_get_booking_by_id' ) ) {
			return new WP_Error( 'marina_booking_api_booking_not_found', 'Booking not found.', array( 'status' => 404 ) );
		}

		$booking = wpbc_api_get_booking_by_id( $booking_id );
		if ( empty( $booking ) || empty( $booking['booking_id'] ) ) {
			return new WP_Error( 'marina_booking_api_booking_not_found', 'Booking not found.', array( 'status' => 404 ) );
		}
		return $booking;
	}

	/**
	 * @param int $booking_id Booking ID.
	 * @return array
	 */
	private static function booking_dates( $booking_id ) {
		global $wpdb;
		$table = $wpdb->prefix . 'bookingdates';
		$rows = $wpdb->get_results( $wpdb->prepare( "SELECT booking_date, approved, type_id FROM {$table} WHERE booking_id = %d ORDER BY booking_date ASC", $booking_id ), ARRAY_A ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		return array_map(
			function( $row ) {
				return array(
					'date'     => $row['booking_date'],
					'approved' => (bool) $row['approved'],
					'type_id'  => $row['type_id'],
				);
			},
			(array) $rows
		);
	}

	/**
	 * @param int $booking_id Booking ID.
	 * @return bool
	 */
	private static function booking_is_approved( $booking_id ) {
		global $wpdb;
		$table = $wpdb->prefix . 'bookingdates';
		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$table} WHERE booking_id = %d AND approved = 0", $booking_id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
		return 0 === $count;
	}

	/**
	 * Normalize request body from JSON or standard REST parameters.
	 *
	 * @param WP_REST_Request $request REST request.
	 * @return array
	 */
	private static function payload( WP_REST_Request $request ) {
		$json = $request->get_json_params();
		return is_array( $json ) ? $json : $request->get_params();
	}

	/**
	 * @param mixed $resource_id Resource ID.
	 * @return int|WP_Error
	 */
	private static function validated_resource_id( $resource_id ) {
		$resource_id = absint( $resource_id );
		if ( ! $resource_id || ! self::resource_exists( $resource_id ) ) {
			return new WP_Error( 'marina_booking_api_invalid_resource', 'The booking resource does not exist.', array( 'status' => 422 ) );
		}
		return $resource_id;
	}

	/**
	 * @param int $resource_id Resource ID.
	 * @return bool
	 */
	private static function resource_exists( $resource_id ) {
		if ( function_exists( 'get_booking_resource_attr' ) ) {
			return (bool) get_booking_resource_attr( $resource_id );
		}

		global $wpdb;
		$table = $wpdb->prefix . 'bookingtypes';
		return (bool) $wpdb->get_var( $wpdb->prepare( "SELECT booking_type_id FROM {$table} WHERE booking_type_id = %d", $resource_id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery,WordPress.DB.DirectDatabaseQuery.NoCaching
	}

	/**
	 * Validate dates as ISO dates or ISO datetimes accepted by the installed API.
	 *
	 * @param mixed $dates Dates array or comma-separated string.
	 * @return array|WP_Error
	 */
	private static function normalize_dates( $dates ) {
		if ( is_string( $dates ) ) {
			$dates = array_filter( array_map( 'trim', explode( ',', $dates ) ) );
		}
		if ( ! is_array( $dates ) || empty( $dates ) || count( $dates ) > 366 ) {
			return new WP_Error( 'marina_booking_api_invalid_dates', 'dates must be an array containing 1 to 366 ISO dates or datetimes.', array( 'status' => 422 ) );
		}

		$normalized = array();
		foreach ( $dates as $date ) {
			$date = trim( (string) $date );
			$date = str_replace( 'T', ' ', $date );
			if ( ! preg_match( '/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/', $date ) ) {
				return new WP_Error( 'marina_booking_api_invalid_date', 'Each date must use YYYY-MM-DD or YYYY-MM-DD HH:MM:SS.', array( 'status' => 422 ) );
			}

			$format = ( 10 === strlen( $date ) ) ? 'Y-m-d' : 'Y-m-d H:i:s';
			$parsed = DateTimeImmutable::createFromFormat( '!' . $format, $date, wp_timezone() );
			$errors = DateTimeImmutable::getLastErrors();
			if ( ! $parsed || ( is_array( $errors ) && ( $errors['warning_count'] > 0 || $errors['error_count'] > 0 ) ) || $parsed->format( $format ) !== $date ) {
				return new WP_Error( 'marina_booking_api_invalid_date', 'One of the supplied dates is not a real calendar date/time.', array( 'status' => 422 ) );
			}
			$normalized[] = $date;
		}

		return array_values( array_unique( $normalized ) );
	}

	/**
	 * Make the explicit date-time boundaries authoritative for Booking Calendar's
	 * start/end fields. Its developer helper converts the date list to date-only
	 * values and reconstructs partial days from these form fields.
	 *
	 * @param array $form_data Normalized form fields.
	 * @param array $dates Normalized ISO dates/date-times.
	 * @return array
	 */
	private static function form_data_with_date_times( $form_data, $dates ) {
		$sorted = $dates;
		sort( $sorted, SORT_STRING );
		if ( count( $sorted ) < 2 ) {
			return $form_data;
		}

		$first = $sorted[0];
		$last  = $sorted[ count( $sorted ) - 1 ];
		if ( 19 === strlen( $first ) && 19 === strlen( $last ) ) {
			$form_data['starttime'] = array( 'value' => substr( $first, 11, 5 ), 'type' => 'text' );
			$form_data['endtime']   = array( 'value' => substr( $last, 11, 5 ), 'type' => 'text' );
		}
		return $form_data;
	}

	/**
	 * Booking Calendar exposes stored field names with the current resource ID
	 * appended (for example name31). Its developer save helper appends that ID
	 * itself, so edits must pass the unsuffixed name to avoid name3131 and to let
	 * the native resource-move helper rewrite it to the destination suffix.
	 *
	 * @param array $form_data Normalized form fields.
	 * @param int   $resource_id Current booking resource ID.
	 * @return array
	 */
	private static function form_data_without_resource_suffix( $form_data, $resource_id ) {
		$suffix = (string) absint( $resource_id );
		if ( '' === $suffix ) {
			return $form_data;
		}

		$result = array();
		foreach ( $form_data as $name => $field ) {
			$canonical_name = (string) $name;
			if ( strlen( $canonical_name ) > strlen( $suffix ) && substr( $canonical_name, -strlen( $suffix ) ) === $suffix ) {
				$canonical_name = substr( $canonical_name, 0, -strlen( $suffix ) );
			}
			$current_value = isset( $result[ $canonical_name ]['value'] ) ? (string) $result[ $canonical_name ]['value'] : '';
			$next_value    = isset( $field['value'] ) ? (string) $field['value'] : '';
			if ( ! isset( $result[ $canonical_name ] ) || ( '' === $current_value && '' !== $next_value ) ) {
				$result[ $canonical_name ] = $field;
			}
		}
		return $result;
	}

	/**
	 * Verify the exact date rows before committing an edit. This prevents an HTTP
	 * success when an installed Booking Calendar version silently drops partial-day
	 * times. Single-calendar-day time slots can use vendor-specific row shapes and
	 * are therefore verified by their form fields instead.
	 *
	 * @param int   $booking_id Booking ID.
	 * @param array $dates Proposed normalized dates/date-times.
	 * @return bool
	 */
	private static function saved_dates_match( $booking_id, $dates ) {
		$expected = array_map(
			function( $date ) {
				return 10 === strlen( $date ) ? $date . ' 00:00:00' : $date;
			},
			$dates
		);
		$expected_days = array_unique( array_map( function( $date ) { return substr( $date, 0, 10 ); }, $expected ) );
		if ( count( $expected_days ) < 2 ) {
			return true;
		}

		$saved = array_map(
			function( $row ) {
				return isset( $row['date'] ) ? (string) $row['date'] : '';
			},
			self::booking_dates( $booking_id )
		);
		sort( $expected, SORT_STRING );
		sort( $saved, SORT_STRING );
		return $expected === $saved;
	}

	/**
	 * Convert validated all-day dates to the date-time format required by the
	 * upstream availability helper.
	 *
	 * @param array $dates Normalized date strings.
	 * @return array
	 */
	private static function dates_for_availability( $dates ) {
		return array_map(
			function( $date ) {
				return ( 10 === strlen( $date ) ) ? $date . ' 00:00:00' : $date;
			},
			$dates
		);
	}

	/**
	 * Validate booking form fields before passing them to Booking Calendar's legacy
	 * tilde/caret serialisation format.
	 *
	 * @param mixed $data Form data.
	 * @return array|WP_Error
	 */
	private static function normalize_form_data( $data, $allow_empty = false ) {
		if ( ! is_array( $data ) || ( ! $allow_empty && empty( $data ) ) || count( $data ) > 80 ) {
			return new WP_Error( 'marina_booking_api_invalid_form_data', $allow_empty ? 'form_data must be an object with at most 80 fields.' : 'form_data must be an object with 1 to 80 fields.', array( 'status' => 422 ) );
		}

		$normalized = array();
		foreach ( $data as $field_name => $field_value ) {
			$field_name = trim( (string) $field_name );
			if ( ! preg_match( '/^[A-Za-z0-9_-]{1,80}$/', $field_name ) ) {
				return new WP_Error( 'marina_booking_api_invalid_field_name', 'Form field names may contain only letters, numbers, underscores, and hyphens.', array( 'status' => 422 ) );
			}

			$type  = 'text';
			$value = $field_value;
			if ( is_array( $field_value ) && array_key_exists( 'value', $field_value ) ) {
				$type  = sanitize_key( isset( $field_value['type'] ) ? $field_value['type'] : 'text' );
				$value = $field_value['value'];
			}
			if ( ! preg_match( '/^[a-z0-9_-]{1,64}$/', $type ) ) {
				return new WP_Error( 'marina_booking_api_invalid_field_type', 'A form field type is invalid.', array( 'status' => 422 ) );
			}
			if ( is_array( $value ) ) {
				$value = implode( ', ', array_map( 'strval', $value ) );
			}
			$value = self::sanitize_text( $value, 2000 );
			$value = str_replace( array( '^', '~' ), ' ', $value );

			if ( 'email' === $field_name && '' !== $value && ! is_email( $value ) ) {
				return new WP_Error( 'marina_booking_api_invalid_email', 'The email field is not a valid email address.', array( 'status' => 422 ) );
			}

			$normalized[ $field_name ] = array(
				'value' => $value,
				'type'  => $type,
			);
		}

		return $normalized;
	}

	/**
	 * Build only the explicitly supported API params. Critically, the API never
	 * accepts a force-save flag, so clients cannot bypass availability checks.
	 *
	 * @param array $payload Request payload.
	 * @return array
	 */
	private static function booking_save_params( $payload ) {
		$send_email = self::boolean_from_payload( $payload, 'send_email', false );
		$approved   = self::boolean_from_payload( $payload, 'approved', false );
		if ( is_wp_error( $send_email ) ) {
			return $send_email;
		}
		if ( is_wp_error( $approved ) ) {
			return $approved;
		}

		return array(
			'is_send_emeils'       => $send_email ? 1 : 0,
			'is_approve_booking'   => $approved ? 1 : 0,
			'booking_form_type'    => isset( $payload['booking_form_type'] ) ? sanitize_key( $payload['booking_form_type'] ) : '',
			'wpdev_active_locale'  => isset( $payload['locale'] ) ? sanitize_text_field( $payload['locale'] ) : get_locale(),
			'is_show_payment_form' => 0,
			'sync_gid'             => isset( $payload['external_id'] ) ? self::sanitize_text( $payload['external_id'], 191 ) : '',
			// Deliberately not exposed: save_booking_even_if_unavailable.
		);
	}

	/**
	 * Strictly parse boolean payload fields so the string "false" does not become
	 * truthy and accidentally approve, email, or trash a booking.
	 *
	 * @param array  $payload Request payload.
	 * @param string $key     Field name.
	 * @param bool   $default Default when omitted.
	 * @return bool|WP_Error
	 */
	private static function boolean_from_payload( $payload, $key, $default = false ) {
		if ( ! array_key_exists( $key, $payload ) ) {
			return $default;
		}

		$value = $payload[ $key ];
		if ( is_bool( $value ) ) {
			return $value;
		}
		if ( is_int( $value ) && ( 0 === $value || 1 === $value ) ) {
			return (bool) $value;
		}
		if ( is_string( $value ) ) {
			$value = strtolower( trim( $value ) );
			if ( in_array( $value, array( 'true', '1' ), true ) ) {
				return true;
			}
			if ( in_array( $value, array( 'false', '0' ), true ) ) {
				return false;
			}
		}

		return new WP_Error( 'marina_booking_api_invalid_boolean', sprintf( '%s must be a boolean.', $key ), array( 'status' => 422 ) );
	}

	/**
	 * @param mixed $value Text value.
	 * @param int   $limit Maximum characters.
	 * @return string
	 */
	private static function sanitize_text( $value, $limit ) {
		$value = wp_strip_all_tags( (string) $value, true );
		$value = preg_replace( '/[\\x00-\\x1F\\x7F]/u', ' ', $value );
		$value = trim( $value );
		return function_exists( 'mb_substr' ) ? mb_substr( $value, 0, $limit ) : substr( $value, 0, $limit );
	}

	/**
	 * @param mixed $date Date boundary.
	 * @param bool  $required Whether it is required.
	 * @return string|WP_Error
	 */
	private static function normalize_date_boundary( $date, $required ) {
		$date = trim( (string) $date );
		if ( '' === $date && ! $required ) {
			return '';
		}
		if ( ! preg_match( '/^\\d{4}-\\d{2}-\\d{2}$/', $date ) || false === strtotime( $date ) ) {
			return new WP_Error( 'marina_booking_api_invalid_boundary_date', 'start and end must use YYYY-MM-DD.', array( 'status' => 422 ) );
		}
		return $date;
	}

	/**
	 * Hook point for an external audit logger. Deliberately excludes customer data.
	 *
	 * @param string $event      Event label.
	 * @param int    $booking_id Booking ID.
	 * @return void
	 */
	private static function audit( $event, $booking_id ) {
		do_action(
			'marina_booking_api_audit',
			array(
				'event'      => $event,
				'booking_id' => (int) $booking_id,
				'user_id'    => get_current_user_id(),
				'occurred_at'=> current_time( 'mysql', true ),
			)
		);
	}

	/**
	 * @param array $data Response data.
	 * @param int   $status HTTP status.
	 * @return WP_REST_Response
	 */
	private static function response( $data, $status = 200 ) {
		return new WP_REST_Response( $data, $status );
	}

	/**
	 * @return bool
	 */
	private static function booking_calendar_ready() {
		return function_exists( 'wpbc_api_booking_add_new' )
			&& function_exists( 'wpbc_api_is_dates_booked' )
			&& function_exists( 'wpbc_api_get_booking_by_id' );
	}
}

register_activation_hook( __FILE__, array( 'Marina_Booking_API', 'activate' ) );
Marina_Booking_API::init();
