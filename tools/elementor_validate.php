<?php
/**
 * Validate an f2h Elementor V4 template against the installed Elementor's prop schemas,
 * without importing it. Run inside WordPress:
 *
 *   wp eval-file tools/elementor_validate.php <bundle>/out/elementor/template.json
 *
 * Prints one line per invalid setting / style prop (element title, style id, prop, error)
 * and a summary. Exit code 1 when anything failed validation.
 */
use Elementor\Plugin;
use Elementor\Modules\AtomicWidgets\Parsers\Props_Parser;
use Elementor\Modules\AtomicWidgets\Parsers\Style_Parser;
use Elementor\Modules\AtomicWidgets\Styles\Style_Schema;

$file = $args[0] ?? null;
if ( ! $file || ! file_exists( $file ) ) {
	WP_CLI::error( 'usage: wp eval-file tools/elementor_validate.php <template.json>' );
}
$tpl = json_decode( file_get_contents( $file ), true );
if ( ! $tpl || empty( $tpl['content'] ) ) {
	WP_CLI::error( 'not a template: missing content[]' );
}

$style_parser = Style_Parser::make( Style_Schema::get() );
$elements     = 0;
$errors       = 0;
$kinds        = [];

$walk = function ( array $el ) use ( &$walk, &$elements, &$errors, &$kinds, $style_parser ) {
	$elements++;
	$kind           = $el['widgetType'] ?? $el['elType'];
	$kinds[ $kind ] = ( $kinds[ $kind ] ?? 0 ) + 1;
	$title          = $el['editor_settings']['title'] ?? $el['id'];

	$instance = Plugin::$instance->elements_manager->create_element_instance( $el );
	if ( ! $instance ) {
		WP_CLI::warning( "$title: unknown element type $kind (is Editor V4 enabled?)" );
		$errors++;
	} else {
		$schema = $instance::get_props_schema();
		$result = Props_Parser::make( $schema )->validate( $el['settings'] ?? [] );
		if ( ! $result->is_valid() ) {
			$errors++;
			WP_CLI::line( "SETTINGS  $title [$kind]: " . $result->errors()->to_string() );
		}
	}
	foreach ( $el['styles'] ?? [] as $style_id => $style ) {
		$result = $style_parser->parse( $style );
		if ( ! $result->is_valid() ) {
			$errors++;
			WP_CLI::line( "STYLE     $title [$kind] $style_id: " . $result->errors()->to_string() );
		}
	}
	foreach ( $el['elements'] ?? [] as $child ) {
		$walk( $child );
	}
};
foreach ( $tpl['content'] as $el ) {
	$walk( $el );
}
ksort( $kinds );
$parts = [];
foreach ( $kinds as $k => $v ) {
	$parts[] = $k . ' x' . $v;
}
WP_CLI::line( sprintf( '%d elements (%s), %d validation error(s)', $elements, implode( ', ', $parts ), $errors ) );
if ( $errors ) {
	exit( 1 );
}
