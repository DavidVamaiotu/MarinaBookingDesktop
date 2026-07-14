<?php
/**
 * Offline behavioral harness for resource edits. It uses synthetic state only.
 */

define( 'ABSPATH', __DIR__ . '/' );
define( 'ARRAY_A', 'ARRAY_A' );

class WP_Error {
	private $code;
	private $message;
	private $data;
	public function __construct( $code, $message, $data = array() ) {
		$this->code = $code;
		$this->message = $message;
		$this->data = $data;
	}
	public function get_error_code() { return $this->code; }
	public function get_error_message() { return $this->message; }
	public function get_error_data() { return $this->data; }
}

class WP_REST_Request implements ArrayAccess {
	private $route;
	private $json;
	public function __construct( $route, $json ) { $this->route = $route; $this->json = $json; }
	public function offsetExists( $offset ) { return array_key_exists( $offset, $this->route ); }
	public function offsetGet( $offset ) { return $this->route[ $offset ]; }
	public function offsetSet( $offset, $value ) { $this->route[ $offset ] = $value; }
	public function offsetUnset( $offset ) { unset( $this->route[ $offset ] ); }
	public function get_json_params() { return $this->json; }
	public function get_params() { return array_merge( $this->route, $this->json ); }
}

class WP_REST_Response {
	public $data;
	public $status;
	public function __construct( $data, $status = 200 ) { $this->data = $data; $this->status = $status; }
}

function register_activation_hook() {}
function add_action() {}
function add_filter() {}
function do_action() {}
function get_current_user_id() { return 1; }
function current_time() { return '2026-07-14 12:00:00'; }
function get_locale() { return 'en_US'; }
function wp_timezone() { return new DateTimeZone( 'Europe/Bucharest' ); }
function absint( $value ) { return abs( (int) $value ); }
function is_wp_error( $value ) { return $value instanceof WP_Error; }
function sanitize_key( $value ) { return preg_replace( '/[^a-z0-9_-]/', '', strtolower( (string) $value ) ); }
function sanitize_text_field( $value ) { return trim( strip_tags( (string) $value ) ); }
function wp_strip_all_tags( $value ) { return strip_tags( (string) $value ); }
function is_email( $value ) { return false !== filter_var( $value, FILTER_VALIDATE_EMAIL ); }
function get_booking_resource_attr( $resource_id ) { return in_array( (int) $resource_id, array( 31, 32 ), true ); }

function initial_state() {
	return array(
		'booking' => array(
			'booking_id' => 77,
			'booking_type' => 31,
			'form' => 'text^name31^Synthetic Guest~text^starttime31^15:00~text^endtime31^12:00',
			'remark' => 'Client kept this note: 450 RON',
			'sync_gid' => 'synthetic-77',
		),
		'dates' => array( '2026-08-10 15:00:01', '2026-08-11 00:00:00', '2026-08-12 12:00:02' ),
	);
}

$GLOBALS['harness_state'] = initial_state();
$GLOBALS['harness_move_fails'] = false;
$GLOBALS['harness_corrupt_dates'] = false;

class Fake_WPDB {
	public $prefix = 'wp_';
	private $snapshot;
	public function query( $sql ) {
		if ( 'START TRANSACTION' === $sql ) { $this->snapshot = $GLOBALS['harness_state']; return true; }
		if ( 'ROLLBACK' === $sql ) { $GLOBALS['harness_state'] = $this->snapshot; return true; }
		if ( 'COMMIT' === $sql ) { $this->snapshot = null; return true; }
		return true;
	}
	public function prepare( $sql, ...$args ) {
		foreach ( $args as $arg ) {
			$sql = preg_replace( '/%d/', (string) (int) $arg, $sql, 1 );
		}
		return $sql;
	}
	public function get_var() { return 0; }
	public function get_results() {
		return array_map(
			function( $date ) { return array( 'booking_date' => $date, 'approved' => 1, 'type_id' => null ); },
			$GLOBALS['harness_state']['dates']
		);
	}
	public function update( $table, $data ) {
		if ( isset( $data['remark'] ) ) { $GLOBALS['harness_state']['booking']['remark'] = $data['remark']; }
		return 1;
	}
}

$GLOBALS['wpdb'] = new Fake_WPDB();

function wpbc_api_get_booking_by_id() { return $GLOBALS['harness_state']['booking']; }

function wpbc_api_booking_add_new( $dates, $form_data, $resource_id, $params ) {
	if ( 31 !== (int) $resource_id || '15:00' !== $form_data['starttime']['value'] || '12:00' !== $form_data['endtime']['value'] ) {
		return new WP_Error( 'harness_bad_edit', 'Edit did not target the current resource with authoritative boundary times.' );
	}
	$fields = array();
	foreach ( $form_data as $name => $field ) {
		$fields[] = $field['type'] . '^' . $name . $resource_id . '^' . $field['value'];
	}
	$GLOBALS['harness_state']['booking']['form'] = implode( '~', $fields );
	$GLOBALS['harness_state']['dates'] = $GLOBALS['harness_corrupt_dates']
		? array_map( function( $date ) { return substr( $date, 0, 10 ) . ' 00:00:00'; }, $dates )
		: array_values( $dates );
	return (int) $params['is_edit_booking']['booking_id'];
}

function wpbc__sql__change_booking_resource_for_booking( $booking_id, $resource_id ) {
	if ( $GLOBALS['harness_move_fails'] ) { return array( false, 'Synthetic destination conflict' ); }
	$old = $GLOBALS['harness_state']['booking']['booking_type'];
	$GLOBALS['harness_state']['booking']['booking_type'] = (int) $resource_id;
	$GLOBALS['harness_state']['booking']['form'] = preg_replace_callback(
		'/\^([A-Za-z0-9_-]+)' . preg_quote( (string) $old, '/' ) . '\^/',
		function( $match ) use ( $resource_id ) { return '^' . $match[1] . (int) $resource_id . '^'; },
		$GLOBALS['harness_state']['booking']['form']
	);
	return array( true, 'Moved' );
}

require dirname( __DIR__, 2 ) . '/wordpress-plugin/marina-booking-api-v1.0.2/marina-booking-api.php';

function harness_assert( $condition, $message ) {
	if ( ! $condition ) { fwrite( STDERR, $message . "\n" ); exit( 1 ); }
}

function invoke_update() {
	$request = new WP_REST_Request(
		array( 'id' => 77 ),
		array(
			'resource_id' => 32,
			'dates' => array( '2026-08-10 15:00:01', '2026-08-11 00:00:00', '2026-08-12 12:00:02' ),
			'form_data' => array( 'name' => array( 'type' => 'text', 'value' => 'Synthetic Guest' ) ),
			'note' => 'Client kept this note: 450 RON',
			'send_email' => false,
		)
	);
	$method = new ReflectionMethod( 'Marina_Booking_API', 'update_booking_operation' );
	$method->setAccessible( true );
	return $method->invoke( null, $request );
}

$result = invoke_update();
if ( $result instanceof WP_Error ) { fwrite( STDERR, $result->get_error_code() . ': ' . $result->get_error_message() . "\n" ); }
harness_assert( $result instanceof WP_REST_Response, 'Successful move did not return a REST response.' );
harness_assert( 32 === $GLOBALS['harness_state']['booking']['booking_type'], 'Destination resource was not saved.' );
harness_assert( false !== strpos( $GLOBALS['harness_state']['booking']['form'], '^name32^Synthetic Guest' ), 'Name suffix was not moved.' );
harness_assert( false !== strpos( $GLOBALS['harness_state']['booking']['form'], '^starttime32^15:00' ), 'Start time was not preserved.' );
harness_assert( false !== strpos( $GLOBALS['harness_state']['booking']['form'], '^endtime32^12:00' ), 'End time was not preserved.' );
harness_assert( 'Client kept this note: 450 RON' === $GLOBALS['harness_state']['booking']['remark'], 'Submitted note was changed.' );

$GLOBALS['harness_state'] = initial_state();
$before = $GLOBALS['harness_state'];
$GLOBALS['harness_move_fails'] = true;
$result = invoke_update();
harness_assert( $result instanceof WP_Error, 'Failed move did not return an error.' );
harness_assert( 'marina_booking_api_resource_move_failed' === $result->get_error_code(), 'Failed move returned the wrong error.' );
harness_assert( $before === $GLOBALS['harness_state'], 'Failed move did not roll back all booking state.' );

$GLOBALS['harness_state'] = initial_state();
$before = $GLOBALS['harness_state'];
$GLOBALS['harness_move_fails'] = false;
$GLOBALS['harness_corrupt_dates'] = true;
$result = invoke_update();
harness_assert( $result instanceof WP_Error, 'Corrupt partial-day save did not return an error.' );
harness_assert( 'marina_booking_api_edit_verification_failed' === $result->get_error_code(), 'Corrupt partial-day save returned the wrong error.' );
harness_assert( $before === $GLOBALS['harness_state'], 'Corrupt partial-day save did not roll back all booking state.' );

echo "WordPress booking resource edit harness: PASS\n";
